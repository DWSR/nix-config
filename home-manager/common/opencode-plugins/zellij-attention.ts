import type { Plugin } from "@opencode-ai/plugin"

export const ZellijAttention: Plugin = async ({ $ }) => {
  const paneId = process.env.ZELLIJ_PANE_ID
  if (!paneId) return {}

  let waitingTimer: ReturnType<typeof setTimeout> | null = null
  let lastSentStatus: string | null = null
  const DEBOUNCE_MS = 200

  const pipe = async (action: string) => {
    await $`zellij pipe --name zellij-attention::${action}::${paneId}`.quiet()
  }

  const cancelWaiting = () => {
    if (waitingTimer) {
      clearTimeout(waitingTimer)
      waitingTimer = null
    }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const status = event.properties.status.type
        if (status === "busy") {
          // Agent resumed work — cancel any pending "waiting" signal
          // and reset state so the next idle transition sends "completed"
          cancelWaiting()
          lastSentStatus = null
        } else if (status === "idle") {
          // Agent finished — send "completed" exactly once per busy→idle transition
          cancelWaiting()
          if (lastSentStatus !== "completed") {
            await pipe("completed")
            lastSentStatus = "completed"
          }
        }
      }

      if (event.type === "permission.updated") {
        // Debounce: only signal "waiting" if the permission isn't auto-resolved
        // within DEBOUNCE_MS. Auto-allowed permissions resolve instantly and
        // fire session.status -> busy, which cancels this timer and resets state.
        cancelWaiting()
        waitingTimer = setTimeout(async () => {
          waitingTimer = null
          if (lastSentStatus !== "waiting") {
            await pipe("waiting")
            lastSentStatus = "waiting"
          }
        }, DEBOUNCE_MS)
      }
    },
  }
}
