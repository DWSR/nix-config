/*
 * augmentation-disabled.test.ts — end-to-end integration test for
 * the R3.6 augmentation-disabled branch (task 5.3 of
 * .kiro/specs/session-compaction).
 *
 * Covers design §Testing Strategy / Integration Tests #3
 * ("Augmentation-disabled branch") via the `createHooks(client)`
 * factory exported by the impl module. Drives the same synthetic
 * opencode-runtime event sequence as the automatic-flow harness
 * (task 5.1), but with augmentation explicitly DISABLED:
 *
 *   1. `session.created` → initializes per-session state under the
 *      main-thread agent identity (parentID=null, agent=null), so
 *      the session is not put on the subagent ignore set.
 *   2. `message.updated` (AssistantMessage with `tokens`) →
 *      tracker accumulates tokens, evaluator trips the
 *      token-threshold gate, CompactionInvoker calls
 *      `client.session.summarize` exactly once. R3.6 explicitly
 *      states that disabling augmentation does NOT disable
 *      compaction — only the cavemem query step is skipped.
 *   3. `experimental.session.compacting` → the augmentation
 *      handler reads `config.augmentationEnabled === false`,
 *      emits `logSuppression(sessionID, "augmentation_disabled")`,
 *      and returns WITHOUT spawning the cavemem subprocess and
 *      WITHOUT touching `output`.
 *
 * Requirements observably satisfied:
 *   - R3.6 — when augmentation is disabled, compaction still
 *     fires on threshold trips, but the cavemem query is skipped
 *     and nothing is injected into the continuation context.
 *
 * Proving "cavemem subprocess is NOT spawned"
 * -------------------------------------------
 * The cleanest hermetic proof: a sentinel `cavemem` stub on PATH
 * that, when invoked, writes a flag file to a known tempdir.
 * After the handler chain completes, `existsSync(flagFile)` MUST
 * be `false`. The SUT uses `node:child_process.spawn` directly so
 * a purely-mock counter would not work — the PATH-override
 * flag-file pattern is borrowed from `cavemem-context-source.test
 * .ts` (which uses an argv-capture file for a related purpose).
 *
 * If the SUT ever regresses to call `spawn("cavemem", …)` on this
 * code path, the stub runs and the flag file appears; the
 * negative assertion below fires immediately.
 *
 * Runner: `node --test` via `opencode-cost-diagnosis-node`. Node
 * 22 with `--experimental-strip-types` strips type annotations at
 * load time and imports the `.ts` source module directly. `node
 * --test <files>` runs every test file in its own worker by
 * default, so the impl module's module-scoped latches
 * (`selfCheckResult`, `pluginConfig`, `sessionStates`,
 * `ignoredSessions`, `inFlightAttempts`) start fresh for this
 * file's process and are not polluted by the sibling integration
 * test files listed alongside it on the same command line.
 *
 * Module-state caveat (intra-file)
 * --------------------------------
 * Within this file the impl module's module-scoped state DOES
 * persist across `it()` blocks. `loadConfigFromEnv()` is LAZY but
 * `getOrLoadConfig()` caches the first parse in `pluginConfig`
 * for the rest of the worker process. We therefore keep the
 * harness to a single end-to-end scenario in one `it()` so the
 * order-of-operations is unambiguous: env vars → mock client →
 * fake cavemem on PATH → session.created → message.updated →
 * experimental.session.compacting → assertions.
 *
 * Env-var ordering: env vars are assigned at module scope BEFORE
 * the impl-module import is observed (Node hoists no statements
 * here; the assignments execute in source order). `loadConfigFrom
 * Env()` is not invoked until the first handler entry, so the
 * `"0"` value below is observed by `parseBoolEnv` correctly.
 */

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import {
  chmodSync,
  existsSync,
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
// AssistantMessage — compaction should fire regardless of the
// augmentation flag.
//
// `SESSION_COMPACTION_AUGMENTATION_ENABLED="0"` puts the impl on
// the R3.6 disabled branch. The HM module's boolean env
// convention (see `parseBoolEnv` in the impl, ~line 1330) is
// `"1"` → true, anything else → false; `"0"` is the canonical
// OFF.
//
// `SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS` is set here only as a
// belt-and-braces guard. The augmentation-disabled path never
// reaches `fetchCavememContext` and therefore never reads this
// value, but the setting also documents that the test would NOT
// give a slow CI runner long enough to spawn cavemem even if the
// short-circuit regressed.
process.env.SESSION_COMPACTION_THRESHOLD_TOKENS = "100"
process.env.SESSION_COMPACTION_AUGMENTATION_ENABLED = "0"
process.env.SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS = "10000"

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
 * latches `"ok"` on first handler entry. Mirrors the harness in
 * `automatic-flow.test.ts`:
 *   - session.created handler reads `parentID` and `agent`; null
 *     for both → main-thread session, never added to the ignore
 *     set.
 *   - message.updated handler reads `time.compacting`; null →
 *     the session has never been compacted, so the evaluator's
 *     cooldown gate is skipped.
 *
 * The double-cast through `unknown` is the minimum disturbance
 * required to satisfy `PluginClient`'s readonly structure while
 * allowing the captured-args arrays to be plain mutable arrays.
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
  readonly flagFile: string
  readonly cleanup: () => void
}

/**
 * Install an executable `cavemem` shell-script stub that, IF
 * invoked, writes a sentinel `flagFile` into its tempdir and
 * exits zero. Then prepend the tempdir to PATH so any
 * `spawn("cavemem", …)` in the SUT resolves to this stub.
 *
 * The test below asserts `existsSync(flagFile)` is FALSE after
 * the handler chain — proving the SUT never invoked the stub on
 * the R3.6 disabled path. If the augmentation-disabled
 * short-circuit ever regresses and `fetchCavememContext` is
 * called, the stub will run, the flag file will appear, and the
 * negative assertion will fail with a readable message.
 *
 * The stub also echoes a payload to stdout so the assertion
 * failure path stays understandable: a regression would produce
 * not only the flag-file failure but also a populated
 * `output.context` from the augmentation step.
 *
 * Caller MUST invoke the returned cleanup in a `finally` block
 * to restore PATH and remove the tempdir. Pattern lifted from
 * `cavemem-context-source.test.ts` and `automatic-flow.test.ts`.
 */
function installFakeCavemem(): FakeCavemem {
  const dir = mkdtempSync(join(tmpdir(), "session-compaction-aug-disabled-"))
  const fakePath = join(dir, "cavemem")
  const flagFile = join(dir, "cavemem-was-invoked")
  // The here-doc body is intentionally simple: touch the flag
  // file with a human-readable sentinel, echo a payload that
  // would (incorrectly) end up in output.context if the SUT
  // regresses, then exit zero.
  writeFileSync(
    fakePath,
    `#!/usr/bin/env bash\necho "cavemem was invoked on the augmentation-disabled path" > "${flagFile}"\necho "augmentation-disabled-regression-sentinel"\n`,
    { mode: 0o755 },
  )
  chmodSync(fakePath, 0o755)
  const originalPath = process.env.PATH ?? ""
  process.env.PATH = `${dir}:${originalPath}`
  return {
    dir,
    flagFile,
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
 *
 * Matches the analogue in `automatic-flow.test.ts` so the only
 * intended difference between the two tests is the augmentation
 * flag value.
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

describe("augmentation-disabled integration — R3.6", () => {
  it("session.created → message.updated trips compaction; experimental.session.compacting short-circuits without spawning cavemem and without touching output", async () => {
    const sessionID = "ses_augmentation_disabled_int_5_3"
    const messageID = "msg_augmentation_disabled_int_5_3_a"

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

      // Sanity: no compaction has been triggered yet, and the
      // cavemem stub has not run (no handler has reached its
      // augmentation path yet, since
      // `experimental.session.compacting` has not been fired).
      assert.equal(
        harness.summarizeCalls.length,
        0,
        "session.created alone must not invoke session.summarize",
      )
      assert.equal(
        existsSync(fake.flagFile),
        false,
        "cavemem stub must not run during session.created",
      )

      // ----- Step 2: message.updated (AssistantMessage) -----
      // The 100/200 split totals 300; threshold 100 → trip.
      // CompactionInvoker funnels through one — and only one —
      // `client.session.summarize` call. R3.6 explicitly says
      // disabling augmentation does NOT disable compaction:
      // threshold trips still fire compaction; only the cavemem
      // augmentation step is skipped.
      await hooks["message.updated"]({
        info: assistantMessage(sessionID, messageID),
      })

      assert.equal(
        harness.summarizeCalls.length,
        1,
        `R3.6 forbids suppressing compaction itself; expected exactly one client.session.summarize call after threshold trip; got ${harness.summarizeCalls.length}`,
      )
      assert.equal(
        harness.summarizeCalls[0].path.id,
        sessionID,
        `summarize must target the tracked sessionID; got ${JSON.stringify(harness.summarizeCalls[0].path)}`,
      )

      // The cavemem stub still must not have run — message.updated
      // does not invoke the augmentation handler. (The
      // augmentation handler is the
      // `experimental.session.compacting` hook, fired by opencode
      // between calling summarize and running its native
      // summary.)
      assert.equal(
        existsSync(fake.flagFile),
        false,
        "cavemem stub must not run during message.updated (augmentation only runs on experimental.session.compacting)",
      )

      // ----- Step 3: experimental.session.compacting -----
      // This is the R3.6 short-circuit under test. With
      // `augmentationEnabled === false`, the handler emits a
      // suppression log entry and returns WITHOUT calling
      // `fetchCavememContext` and WITHOUT touching `output`.
      const output: { context: string[]; prompt?: string } = {
        context: [],
      }
      await hooks["experimental.session.compacting"](
        { sessionID },
        output,
      )

      // R3.6 primary assertion: the cavemem subprocess is NEVER
      // spawned on the augmentation-disabled path. If the
      // short-circuit at impl line ~1835 regresses and
      // `fetchCavememContext` is called, the PATH-resolved stub
      // runs and writes `flagFile` — this assertion is the
      // mechanically deterministic proof. The check is the
      // single most important assertion in this file.
      assert.equal(
        existsSync(fake.flagFile),
        false,
        `R3.6: cavemem subprocess MUST NOT spawn when augmentationEnabled is false; flag file at ${fake.flagFile} should not exist`,
      )

      // R3.6 secondary assertion: `output.context` is unchanged
      // from its initial empty state. The handler must NOT push
      // anything. This is observably distinct from the "cavemem
      // returned empty" path (R3.3 / `logSuppression(...,
      // "augmentation_empty")`), which the unit tests cover; on
      // R3.6, the handler returns before even consulting
      // cavemem.
      assert.equal(
        output.context.length,
        0,
        `R3.6: output.context must remain empty on the augmentation-disabled path; got length=${output.context.length}, contents=${JSON.stringify(output.context)}`,
      )

      // R3.5 + R3.6: the handler augments at most, never
      // replaces; on R3.6 it does not even augment. `prompt`
      // must remain strictly `undefined` (its initial state).
      assert.equal(
        output.prompt,
        undefined,
        `R3.6: output.prompt must NOT be assigned on the augmentation-disabled path; got ${JSON.stringify(output.prompt)}`,
      )

      // R3.6 observability assertion: the handler emits one
      // `logSuppression` entry with `extra.reason ===
      // "augmentation_disabled"`. The `logSuppression` wrapper
      // (impl ~line 1086) emits:
      //   { service: "session-compaction",
      //     level: "info",
      //     message: "compaction suppressed",
      //     extra: { sessionID, reason } }
      // so we filter on `extra.reason`, NOT on the `message`
      // field. The `message` is reused across all suppression
      // paths; the `reason` carries the semantic intent. (See
      // task 3.4 implementation notes in tasks.md and the
      // skipped-reason TODO in the impl: the wrapper's name was
      // preserved across the augmentation-skipped path because
      // it lets the operator grep one source of truth for any
      // suppression cause.)
      const suppressionEntries = harness.logs.filter(
        (l) =>
          typeof l.extra === "object" &&
          l.extra !== null &&
          (l.extra as Record<string, unknown>).reason ===
            "augmentation_disabled",
      )
      assert.equal(
        suppressionEntries.length,
        1,
        `R3.6: expected exactly one app.log entry with extra.reason === "augmentation_disabled"; got ${suppressionEntries.length}. All captured logs: ${JSON.stringify(harness.logs, null, 2)}`,
      )

      // The suppression entry must also carry the tracked
      // sessionID and be tagged with the canonical service name,
      // so an operator grepping `service:session-compaction
      // reason:augmentation_disabled` finds it.
      const entry = suppressionEntries[0]
      assert.equal(
        entry.service,
        "session-compaction",
        `suppression entry must be tagged with service "session-compaction"; got ${JSON.stringify(entry)}`,
      )
      assert.equal(
        entry.level,
        "info",
        `suppression entry must be info-level; got ${JSON.stringify(entry)}`,
      )
      assert.equal(
        (entry.extra as Record<string, unknown>).sessionID,
        sessionID,
        `suppression entry must carry the tracked sessionID; got ${JSON.stringify(entry.extra)}`,
      )
    } finally {
      fake.cleanup()
    }
  })
})
