import { it } from "node:test"
import { strict as assert } from "node:assert"
import {
  createHooks,
  type PluginClient,
} from "../../../home-manager/common/session-compaction-internal/session-compaction-impl.ts"

// Keep the automatic threshold out of the manual scenario.
process.env.SESSION_COMPACTION_THRESHOLD_TOKENS = "100000"

function harness() {
  const summaries: string[] = []
  const toasts: Array<{ message: string; variant: string }> = []
  const logs: Array<{ message: string; extra?: Record<string, unknown> }> = []
  const client = {
    session: {
      get: async () => ({ parentID: null, agent: null, time: { compacting: null } }),
      summarize: async ({ path }: { path: { id: string } }) => {
        summaries.push(path.id)
        return true
      },
    },
    app: {
      log: async ({ body }: { body: { message: string; extra?: Record<string, unknown> } }) => {
        logs.push(body)
        return true
      },
    },
    tui: {
      showToast: async ({ body }: { body: { message: string; variant: string } }) => {
        toasts.push(body)
        return true
      },
    },
  } as unknown as PluginClient
  return { hooks: createHooks(client), summaries, toasts, logs }
}

it("/compact calls the native summarizer after a turn, independent of the automatic threshold", async () => {
  const sessionID = "ses_manual_native"
  const { hooks, summaries, toasts, logs } = harness()

  await hooks["session.created"]({ info: { id: sessionID } })
  await hooks["message.updated"]({
    info: {
      id: "msg_manual_native",
      sessionID,
      role: "assistant",
      tokens: {
        input: 10,
        output: 5,
        reasoning: 0,
        cache: { read: 10, write: 0 },
      },
    },
  })
  assert.deepEqual(summaries, [], "below-threshold update must not compact")

  await hooks["command.executed"]({ name: "compact", sessionID, arguments: "", messageID: "msg_manual_native" })
  assert.deepEqual(summaries, [sessionID])
  assert.deepEqual(toasts, [])

  await hooks["session.compacted"]({ sessionID })
  assert.ok(logs.some(({ message, extra }) =>
    message === "session compacted" && extra?.sessionID === sessionID && extra?.trigger === "manual",
  ))
})

it("/compact refuses a zero-turn session with an informational toast", async () => {
  const sessionID = "ses_manual_zero_turn"
  const { hooks, summaries, toasts, logs } = harness()

  await hooks["session.created"]({ info: { id: sessionID } })
  await hooks["command.executed"]({ name: "compact", sessionID, arguments: "", messageID: "msg_manual_zero_turn" })

  assert.deepEqual(summaries, [])
  assert.deepEqual(toasts, [{ message: "Nothing to compact.", variant: "info" }])
  assert.ok(logs.some(({ message, extra }) =>
    message === "compaction suppressed" && extra?.reason === "zero_turns_manual",
  ))
})
