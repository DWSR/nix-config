import { it } from "node:test"
import { strict as assert } from "node:assert"
import {
  createHooks,
  type PluginClient,
} from "../../../home-manager/common/session-compaction-internal/session-compaction-impl.ts"

process.env.SESSION_COMPACTION_THRESHOLD_TOKENS = "100"

it("compacts with OpenCode's native summarizer after the token threshold", async () => {
  const sessionID = "ses_automatic_native"
  const summaries: string[] = []
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
    tui: { showToast: async () => true },
  } as unknown as PluginClient
  const hooks = createHooks(client)

  assert.equal("experimental.session.compacting" in hooks, false)
  await hooks["session.created"]({ info: { id: sessionID } })
  assert.deepEqual(summaries, [])

  await hooks["message.updated"]({
    info: {
      id: "msg_automatic_native",
      sessionID,
      role: "assistant",
      tokens: {
        input: 100,
        output: 20,
        reasoning: 0,
        cache: { read: 200, write: 0 },
      },
    },
  })

  assert.deepEqual(summaries, [sessionID])
  assert.ok(logs.some(({ message, extra }) =>
    message === "compaction triggered" &&
    extra?.trigger === "automatic" &&
    extra?.reason === "tokens_exceeded:300",
  ))

  await hooks["session.compacted"]({ sessionID })
  assert.ok(logs.some(({ message, extra }) =>
    message === "session compacted" && extra?.trigger === "automatic",
  ))
})
