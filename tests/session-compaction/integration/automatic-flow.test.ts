/*
 * automatic-flow.test.ts — end-to-end integration test for the
 * automatic-compaction path (task 5.1 of
 * .kiro/specs/session-compaction).
 *
 * Covers design §Testing Strategy / Integration Tests #1
 * ("Automatic flow end-to-end") via the `createHooks(client)`
 * factory exported by the impl module. Drives a synthetic
 * opencode-runtime event sequence:
 *
 *   1. `session.created` → initializes per-session state under the
 *      main-thread agent identity (parentID=null, agent=null), so
 *      the session is not put on the subagent ignore set.
 *   2. `message.updated` (AssistantMessage with `tokens`) →
 *      tracker accumulates tokens, evaluator trips the
 *      token-threshold gate, CompactionInvoker calls
 *      `client.session.summarize` exactly once.
 *   3. `experimental.session.compacting` → augmentation handler
 *      spawns the (PATH-stubbed) `cavemem` binary, retrieves a
 *      recognizable payload, and pushes it onto `output.context`.
 *      `output.prompt` is NEVER assigned by the handler.
 *
 * Requirements observably satisfied:
 *   - R2.3 (token threshold triggers compaction) — one
 *     `client.session.summarize` invocation captured with the
 *     expected `sessionID` after the AssistantMessage event.
 *   - R3.1 (pre-compaction query) — the cavemem stub script is
 *     invoked by `experimental.session.compacting` and surfaces a
 *     payload to the augmentation handler.
 *   - R3.2 (context pushed to output.context) — the stubbed
 *     payload appears verbatim in `output.context[0]`; no other
 *     mutations to `output`.
 *
 * Runner: `node --test` via `opencode-cost-diagnosis-node`. Node
 * 22 with `--experimental-strip-types` strips type annotations at
 * load time and imports the `.ts` source module directly. `node
 * --test <files>` runs every test file in its own worker by
 * default, so the impl module's module-scoped latches
 * (`selfCheckResult`, `pluginConfig`, `sessionStates`,
 * `ignoredSessions`, `inFlightAttempts`) start fresh for this
 * file's process and are not polluted by the unit-test files
 * listed alongside it on the same command line.
 *
 * Module-state caveat (intra-file)
 * --------------------------------
 * Within this file the impl module's module-scoped state DOES
 * persist across `it()` blocks. We therefore keep the harness to
 * a single end-to-end scenario in one `it()` so the order-of-
 * operations is unambiguous: env vars → mock client → fake cavemem
 * on PATH → session.created → message.updated → compacting.
 *
 * Env-var ordering: `loadConfigFromEnv()` is LAZY — it runs the
 * first time `getOrLoadConfig()` is called inside a handler, not
 * at module-load time. Setting env vars at module scope below
 * (after the impl-module import) is therefore observed correctly
 * provided no handler invocation precedes the assignment. We
 * assign env vars in a top-level block before the `describe`.
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
// AssistantMessage tokens below total `input(100) + cacheRead(200)
// = 300` by the evaluator's formula. A threshold of 100 means
// 300 > 100 trips `tokens_exceeded` on the very first
// AssistantMessage, exactly what task 5.1 asks for.
//
// Augmentation is explicitly enabled so the
// `experimental.session.compacting` handler proceeds past the
// R3.6 disabled-gate and invokes the cavemem stub.
//
// The cavemem timeout is generous (10s) so a slow CI runner
// spawning bash cannot SIGTERM the stub before it echoes.
process.env.SESSION_COMPACTION_THRESHOLD_TOKENS = "100"
process.env.SESSION_COMPACTION_AUGMENTATION_ENABLED = "1"
process.env.SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS = "10000"

// Recognizable sentinel emitted by the fake cavemem script.
// Asserting on a literal string rather than a regex keeps the
// failure message readable when the assertion regresses.
const STUB_CAVEMEM_PAYLOAD = "stub-cavemem-context-for-automatic-flow"

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
 * latches `"ok"` on first handler entry. `session.get` returns the
 * subset of the opencode Session that the plugin's handlers read:
 *   - session.created handler reads `parentID` and `agent`; null
 *     for both → main-thread session, never added to the ignore
 *     set.
 *   - message.updated handler reads `time.compacting`; null →
 *     the session has never been compacted, so the evaluator's
 *     cooldown gate is skipped.
 *
 * The double-cast through `unknown` mirrors `plugin-self-check
 * .test.ts:110`: it is the minimum disturbance required to
 * satisfy `PluginClient`'s readonly structure while allowing the
 * captured-args arrays to be plain mutable arrays.
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
 * `cavemem-context-source.test.ts:73-92`.
 */
function installFakeCavemem(): FakeCavemem {
  const dir = mkdtempSync(join(tmpdir(), "session-compaction-int-"))
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

// ---------------------------------------------------------------
// Test
// ---------------------------------------------------------------

describe("automatic-flow integration — R2.3 + R3.1 + R3.2", () => {
  it("session.created → message.updated trips compaction; experimental.session.compacting pushes stubbed cavemem text onto output.context without touching output.prompt", async () => {
    const sessionID = "ses_automatic_flow_int_5_1"
    const messageID = "msg_automatic_flow_int_5_1_a"

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

      // Sanity: no compaction has been triggered yet.
      assert.equal(
        harness.summarizeCalls.length,
        0,
        "session.created alone must not invoke session.summarize",
      )

      // ----- Step 2: message.updated (AssistantMessage) -----
      // The 100/200 split totals 300; threshold 100 → trip.
      // CompactionInvoker funnels through one — and only one —
      // `client.session.summarize` call (R2.3).
      await hooks["message.updated"]({
        info: assistantMessage(sessionID, messageID),
      })

      assert.equal(
        harness.summarizeCalls.length,
        1,
        `expected exactly one client.session.summarize call after threshold trip; got ${harness.summarizeCalls.length}`,
      )
      assert.equal(
        harness.summarizeCalls[0].path.id,
        sessionID,
        `summarize must target the tracked sessionID; got ${JSON.stringify(harness.summarizeCalls[0].path)}`,
      )

      // ----- Step 3: experimental.session.compacting -----
      // opencode fires this hook between calling summarize and
      // running its native summary. The augmentation handler
      // spawns `cavemem search …` (resolved via our PATH
      // override to the fake script), reads the stubbed payload,
      // and pushes it onto output.context. output.prompt is
      // never assigned by the handler.
      const output: { context: string[]; prompt?: string } = {
        context: [],
      }
      await hooks["experimental.session.compacting"](
        { sessionID },
        output,
      )

      // R3.2: exactly one entry pushed; verbatim stub text
      // present. The fake's `echo` appends a trailing newline,
      // so we assert containment rather than strict equality.
      assert.equal(
        output.context.length,
        1,
        `expected output.context to grow by exactly one entry from the augmentation handler; got length=${output.context.length}, contents=${JSON.stringify(output.context)}`,
      )
      assert.ok(
        output.context[0].includes(STUB_CAVEMEM_PAYLOAD),
        `output.context[0] must carry the stubbed cavemem payload (R3.1+R3.2); got ${JSON.stringify(output.context[0])}`,
      )

      // R3.5 negative assertion: the handler augments, never
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
})
