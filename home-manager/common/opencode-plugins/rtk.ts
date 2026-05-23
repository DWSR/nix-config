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
    readonly state?: StartupState
    readonly effective?: string
    readonly usageTag?: string
    readonly reason: string
    readonly tool?: "bash" | "shell"
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
  readonly rewriteCommand?: (command: string) => Promise<RewriteResult>
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

type ToolExecuteBeforeInput = {
  readonly tool?: unknown
}

type MutableToolOutput = {
  args?: {
    command?: unknown
    readonly [key: string]: unknown
  }
}

type RewriteErrorCode = "rtk-unavailable" | "invalid-command" | "rewrite-failed"

type RewriteResult =
  | { readonly ok: true; readonly command: string; readonly changed: boolean }
  | { readonly ok: false; readonly code: RewriteErrorCode; readonly message: string }

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

async function defaultRewriteCommand(command: string): Promise<RewriteResult> {
  return await new Promise((resolve) => {
    let stdout = ""

    try {
      const child = spawn("rtk", ["rewrite", command], {
        stdio: ["ignore", "pipe", "ignore"],
      })

      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk) => {
        stdout += chunk
      })
      child.once("error", () => {
        resolve({ ok: false, code: "rtk-unavailable", message: "rtk unavailable" })
      })
      child.once("exit", (code) => {
        if (code !== 0) {
          resolve({ ok: false, code: "rewrite-failed", message: "rtk rewrite failed" })
          return
        }

        const rewritten = stdout.trimEnd()
        resolve({ ok: true, command: rewritten, changed: rewritten !== command })
      })
    } catch {
      resolve({ ok: false, code: "rtk-unavailable", message: "rtk unavailable" })
    }
  })
}

async function hasRtkBinary(ctx: RtkPluginContext): Promise<boolean> {
  return await (ctx.rtk?.hasRtkBinary ?? defaultHasRtkBinary)()
}

async function rewriteCommand(ctx: RtkPluginContext, command: string): Promise<RewriteResult> {
  return await (ctx.rtk?.rewriteCommand ?? defaultRewriteCommand)(command)
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

function isRoutedTool(input: ToolExecuteBeforeInput): input is { readonly tool: "bash" | "shell" } {
  if (typeof input.tool !== "string") return false
  const tool = input.tool.toLowerCase()
  return tool === "bash" || tool === "shell"
}

async function emitRewriteLog(
  client: unknown,
  params: {
    readonly level: Extract<LogLevel, "warn" | "error">
    readonly message: string
    readonly reason: RewriteErrorCode
    readonly tool: "bash" | "shell"
  },
): Promise<void> {
  if (!isAppLogger(client)) return

  try {
    await client.app.log({
      body: {
        service: RTK_PLUGIN_SERVICE,
        level: params.level,
        message: params.message,
        extra: {
          reason: params.reason,
          tool: params.tool,
        },
      },
    })
  } catch {
    // Logging is local observability only; it must not block tool execution.
  }
}

async function handleToolExecuteBefore(
  ctx: RtkPluginContext,
  input: ToolExecuteBeforeInput,
  output: MutableToolOutput,
): Promise<void> {
  if (!isRoutedTool(input)) return

  const tool = input.tool.toLowerCase() as "bash" | "shell"
  const args = output.args
  const command = args?.command
  if (!args || typeof command !== "string") {
    await emitRewriteLog(ctx.client, {
      level: "warn",
      message: "rtk plugin rewrite skipped",
      reason: "invalid-command",
      tool,
    })
    return
  }

  let result: RewriteResult
  try {
    result = await rewriteCommand(ctx, command)
  } catch {
    result = { ok: false, code: "rewrite-failed", message: "rtk rewrite failed" }
  }

  if (!result.ok) {
    await emitRewriteLog(ctx.client, {
      level: "error",
      message: "rtk plugin rewrite failed",
      reason: result.code,
      tool,
    })
    return
  }

  if (result.changed && result.command.length > 0 && result.command !== command) {
    args.command = result.command
  }
}

export const RtkPlugin: Plugin = async (input) => {
  const ctx = input as RtkPluginContext
  const decision = await decideStartupState(ctx)
  await emitStartupLog(ctx.client, decision)

  if (decision.state !== "enabled") return {}

  return {
    "tool.execute.before": async (input: unknown, output: unknown) => {
      await handleToolExecuteBefore(
        ctx,
        input as ToolExecuteBeforeInput,
        output as MutableToolOutput,
      )
    },
  }
}
