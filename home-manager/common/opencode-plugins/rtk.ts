import { spawn } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"

export const RTK_PLUGIN_SERVICE = "rtk-opencode"

type StartupState =
  | "enabled"
  | "disabled"
  | "missing-binary"
  | "unsafe-telemetry"
  | "incompatible-surface"

type LogLevel = "debug" | "info" | "warn" | "error"

type StartupLog = {
  readonly service: typeof RTK_PLUGIN_SERVICE
  readonly level: LogLevel
  readonly message: string
  readonly extra: {
    readonly state: StartupState
    readonly effective: string
    readonly usageTag?: string
    readonly reason: string
  }
}

export type AppLogBody = StartupLog

export type RtkPluginEnvironment = {
  readonly OPENCODE_RTK_EFFECTIVE?: string
  readonly OPENCODE_RTK_USAGE_TAG?: string
  readonly OPENCODE_RTK_DISABLE_REASON?: string
  readonly RTK_TELEMETRY_DISABLED?: string
}

type AppLogger = {
  readonly app: {
    readonly log: (params: { readonly body: AppLogBody }) => Promise<unknown>
  }
}

type RtkTestControls = {
  readonly env?: RtkPluginEnvironment
  readonly hasRtkBinary?: () => Promise<boolean>
}

type RtkPluginContext = {
  readonly client?: unknown
  readonly rtk?: RtkTestControls
}

type RtkStartupDecision = {
  readonly state: StartupState
  readonly effective: string
  readonly usageTag?: string
  readonly reason: string
}

function getRuntimeEnv(ctx: RtkPluginContext): RtkPluginEnvironment {
  return ctx.rtk?.env ?? process.env
}

function isAppLogger(client: unknown): client is AppLogger {
  if (client === null || typeof client !== "object") return false
  const app = (client as { readonly app?: unknown }).app
  if (app === null || typeof app !== "object") return false
  return typeof (app as { readonly log?: unknown }).log === "function"
}

function disabledReason(env: RtkPluginEnvironment): string {
  const reason = env.OPENCODE_RTK_DISABLE_REASON
  return typeof reason === "string" && reason.length > 0 ? reason : "disabled"
}

async function defaultHasRtkBinary(): Promise<boolean> {
  return await new Promise((resolve) => {
    try {
      const child = spawn("rtk", ["--version"], {
        stdio: ["ignore", "ignore", "ignore"],
      })

      child.once("error", () => resolve(false))
      child.once("exit", (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
}

async function hasRtkBinary(ctx: RtkPluginContext): Promise<boolean> {
  return await (ctx.rtk?.hasRtkBinary ?? defaultHasRtkBinary)()
}

async function decideStartupState(ctx: RtkPluginContext): Promise<RtkStartupDecision> {
  const env = getRuntimeEnv(ctx)
  const effective = env.OPENCODE_RTK_EFFECTIVE ?? "disabled"
  const usageTag = env.OPENCODE_RTK_USAGE_TAG

  if (effective !== "enabled") {
    return {
      state: "disabled",
      effective,
      usageTag,
      reason: disabledReason(env),
    }
  }

  if (!isAppLogger(ctx.client)) {
    return {
      state: "incompatible-surface",
      effective,
      usageTag,
      reason: "client.app.log",
    }
  }

  if (env.RTK_TELEMETRY_DISABLED !== "1") {
    return {
      state: "unsafe-telemetry",
      effective,
      usageTag,
      reason: "telemetry-unsafe",
    }
  }

  if (!(await hasRtkBinary(ctx))) {
    return {
      state: "missing-binary",
      effective,
      usageTag,
      reason: "missing-binary",
    }
  }

  return {
    state: "enabled",
    effective: "enabled",
    usageTag,
    reason: "ready",
  }
}

function messageFor(state: StartupState): string {
  switch (state) {
    case "enabled":
      return "rtk plugin enabled"
    case "disabled":
      return "rtk plugin disabled"
    case "missing-binary":
      return "rtk plugin missing binary"
    case "unsafe-telemetry":
      return "rtk plugin unsafe telemetry"
    case "incompatible-surface":
      return "rtk plugin incompatible surface"
  }
}

function levelFor(state: StartupState): LogLevel {
  return state === "enabled" || state === "disabled" ? "info" : "error"
}

function logBody(decision: RtkStartupDecision): AppLogBody {
  return {
    service: RTK_PLUGIN_SERVICE,
    level: levelFor(decision.state),
    message: messageFor(decision.state),
    extra: {
      state: decision.state,
      effective: decision.effective,
      usageTag: decision.usageTag,
      reason: decision.reason,
    },
  }
}

async function emitStartupLog(client: unknown, decision: RtkStartupDecision): Promise<void> {
  const body = logBody(decision)

  if (!isAppLogger(client)) {
    if (decision.state === "incompatible-surface") {
      console.error(JSON.stringify({ body }))
    }
    return
  }

  try {
    await client.app.log({ body })
  } catch {
    // Logging is local observability only; it must not block OpenCode startup.
  }
}

export const RtkPlugin: Plugin = async (input) => {
  const ctx = input as RtkPluginContext
  const decision = await decideStartupState(ctx)
  await emitStartupLog(ctx.client, decision)

  if (decision.state !== "enabled") return {}

  return {
    "tool.execute.before": async () => {
      // Task 3.1 registers the hook only after startup self-checks pass.
      // Task 3.2 owns command inspection and RTK rewrite behavior.
    },
  }
}
