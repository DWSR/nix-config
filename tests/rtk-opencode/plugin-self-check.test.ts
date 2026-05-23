import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  RTK_PLUGIN_SERVICE,
  RtkPlugin,
  type AppLogBody,
  type RtkPluginEnvironment,
} from "../../home-manager/common/opencode-plugins/rtk.ts"

type ToolExecuteBeforeHook = (
  input: { readonly tool: string },
  output: { args?: { command?: unknown; readonly [key: string]: unknown } },
) => Promise<void>

interface CapturedClient {
  readonly logs: AppLogBody[]
  readonly client: {
    readonly app: {
      readonly log: (params: { readonly body: AppLogBody }) => Promise<boolean>
    }
  }
}

function makeClient(): CapturedClient {
  const logs: AppLogBody[] = []
  return {
    logs,
    client: {
      app: {
        log: async (params) => {
          logs.push(params.body)
          return true
        },
      },
    },
  }
}

function makeEnv(overrides: Partial<RtkPluginEnvironment> = {}): RtkPluginEnvironment {
  return {
    OPENCODE_RTK_EFFECTIVE: "enabled",
    OPENCODE_RTK_USAGE_TAG: "rtk:enabled",
    RTK_TELEMETRY_DISABLED: "1",
    OPENCODE_RTK_DISABLE_REASON: undefined,
    ...overrides,
  }
}

async function makeEnabledHook(options: {
  readonly rewrite: (command: string) => Promise<unknown>
  readonly logs?: AppLogBody[]
}): Promise<ToolExecuteBeforeHook> {
  const captured = options.logs
    ? {
        logs: options.logs,
        client: {
          app: {
            log: async (params: { readonly body: AppLogBody }) => {
              options.logs?.push(params.body)
              return true
            },
          },
        },
      }
    : makeClient()
  const hooks = await RtkPlugin({
    client: captured.client,
    rtk: {
      env: makeEnv(),
      hasRtkBinary: async () => true,
      rewriteCommand: options.rewrite,
    },
  })

  assert.equal(typeof hooks["tool.execute.before"], "function")
  return hooks["tool.execute.before"] as ToolExecuteBeforeHook
}

describe("RTK plugin startup self-check", () => {
  it("disabled state returns no rewrite hook and logs the disabled reason", async () => {
    const { client, logs } = makeClient()

    const hooks = await RtkPlugin({
      client,
      rtk: {
        env: makeEnv({
          OPENCODE_RTK_EFFECTIVE: "disabled",
          OPENCODE_RTK_USAGE_TAG: "rtk:disabled",
          OPENCODE_RTK_DISABLE_REASON: "override",
        }),
        hasRtkBinary: async () => true,
      },
    })

    assert.deepEqual(hooks, {})
    assert.equal(logs.length, 1)
    assert.equal(logs[0].service, RTK_PLUGIN_SERVICE)
    assert.equal(logs[0].level, "info")
    assert.equal(logs[0].message, "rtk plugin disabled")
    assert.equal(logs[0].extra.state, "disabled")
    assert.equal(logs[0].extra.reason, "override")
  })

  it("enabled state with unsafe telemetry returns no rewrite hook and logs unsafe telemetry", async () => {
    const { client, logs } = makeClient()

    const hooks = await RtkPlugin({
      client,
      rtk: {
        env: makeEnv({ RTK_TELEMETRY_DISABLED: "0" }),
        hasRtkBinary: async () => true,
      },
    })

    assert.deepEqual(hooks, {})
    assert.equal(logs.length, 1)
    assert.equal(logs[0].level, "error")
    assert.equal(logs[0].message, "rtk plugin unsafe telemetry")
    assert.equal(logs[0].extra.state, "unsafe-telemetry")
    assert.equal(logs[0].extra.reason, "telemetry-unsafe")
  })

  it("enabled state with missing rtk binary returns no rewrite hook and logs missing binary", async () => {
    const { client, logs } = makeClient()

    const hooks = await RtkPlugin({
      client,
      rtk: {
        env: makeEnv(),
        hasRtkBinary: async () => false,
      },
    })

    assert.deepEqual(hooks, {})
    assert.equal(logs.length, 1)
    assert.equal(logs[0].level, "error")
    assert.equal(logs[0].message, "rtk plugin missing binary")
    assert.equal(logs[0].extra.state, "missing-binary")
    assert.equal(logs[0].extra.reason, "missing-binary")
  })

  it("missing client.app.log returns no rewrite hook and surfaces incompatible state locally", async () => {
    const errors: string[] = []
    const originalError = console.error
    console.error = (message?: unknown) => {
      errors.push(String(message))
    }

    try {
      const hooks = await RtkPlugin({
        client: {},
        rtk: {
          env: makeEnv(),
          hasRtkBinary: async () => true,
        },
      })

      assert.deepEqual(hooks, {})
      assert.equal(errors.length, 1)
      const logged = JSON.parse(errors[0]) as { readonly body: AppLogBody }
      assert.equal(logged.body.message, "rtk plugin incompatible surface")
      assert.equal(logged.body.extra.state, "incompatible-surface")
      assert.equal(logged.body.extra.reason, "client.app.log")
    } finally {
      console.error = originalError
    }
  })

  it("enabled state with safe telemetry and rtk binary registers future rewrite hook without command logging", async () => {
    const { client, logs } = makeClient()

    const hooks = await RtkPlugin({
      client,
      rtk: {
        env: makeEnv(),
        hasRtkBinary: async () => true,
      },
    })

    assert.equal(typeof hooks["tool.execute.before"], "function")
    assert.equal(logs.length, 1)
    assert.equal(logs[0].message, "rtk plugin enabled")
    assert.equal(logs[0].extra.state, "enabled")

    const serializedLogs = JSON.stringify(logs)
    assert.equal(serializedLogs.includes("echo secret"), false)
    assert.equal(serializedLogs.includes("command output"), false)
  })
})

describe("RTK plugin command rewrite", () => {
  it("rewrites Bash command text when RTK returns a non-empty changed command", async () => {
    const calls: string[] = []
    const hook = await makeEnabledHook({
      rewrite: async (command) => {
        calls.push(command)
        return { ok: true, command: "rtk git status --short", changed: true }
      },
    })
    const output = { args: { command: "git status --short", cwd: "/repo" } }

    await hook({ tool: "Bash" }, output)

    assert.deepEqual(calls, ["git status --short"])
    assert.equal(output.args.command, "rtk git status --short")
    assert.equal(output.args.cwd, "/repo")
  })

  it("rewrites shell command text when RTK returns a non-empty changed command", async () => {
    const hook = await makeEnabledHook({
      rewrite: async () => ({ ok: true, command: "rtk npm test", changed: true }),
    })
    const output = { args: { command: "npm test" } }

    await hook({ tool: "shell" }, output)

    assert.equal(output.args.command, "rtk npm test")
  })

  it("leaves native and unknown tools outside RTK processing", async () => {
    const calls: string[] = []
    const hook = await makeEnabledHook({
      rewrite: async (command) => {
        calls.push(command)
        return { ok: true, command: "rtk should-not-run", changed: true }
      },
    })
    for (const tool of ["Read", "Grep", "Glob", "WebFetch", "Task", "LSP", "unknown"]) {
      const output = {
        args: { command: `${tool} secret`, pattern: "*.ts" },
        result: { output: `${tool} output` },
      }
      const originalOutput = structuredClone(output)

      await hook({ tool }, output)

      assert.deepEqual(output, originalOutput)
    }

    assert.deepEqual(calls, [])
  })

  it("bypasses missing or non-string command shapes and logs a local reason", async () => {
    const logs: AppLogBody[] = []
    const hook = await makeEnabledHook({
      logs,
      rewrite: async () => ({ ok: true, command: "rtk should-not-run", changed: true }),
    })
    const output = { args: { command: ["git", "status"] } }

    await hook({ tool: "bash" }, output)

    assert.deepEqual(output.args.command, ["git", "status"])
    const log = logs[logs.length - 1]
    assert.equal(log.level, "warn")
    assert.equal(log.message, "rtk plugin rewrite skipped")
    assert.equal(log.extra.reason, "invalid-command")
    assert.equal(JSON.stringify(logs).includes("git"), false)
  })

  it("leaves the original command unchanged and logs locally when rewrite fails", async () => {
    const logs: AppLogBody[] = []
    const hook = await makeEnabledHook({
      logs,
      rewrite: async () => ({
        ok: false,
        code: "rewrite-failed",
        message: "command output included secret-token",
      }),
    })
    const output = { args: { command: "echo secret-token" } }

    await hook({ tool: "bash" }, output)

    assert.equal(output.args.command, "echo secret-token")
    const log = logs[logs.length - 1]
    assert.equal(log.level, "error")
    assert.equal(log.message, "rtk plugin rewrite failed")
    assert.equal(log.extra.reason, "rewrite-failed")
    const serializedLogs = JSON.stringify(logs)
    assert.equal(serializedLogs.includes("echo secret-token"), false)
    assert.equal(serializedLogs.includes("command output"), false)
  })

  it("does not own the underlying Bash result and only mutates command text before execution", async () => {
    const hook = await makeEnabledHook({
      rewrite: async () => ({ ok: true, command: "rtk false", changed: true }),
    })
    const output = {
      args: { command: "false" },
      result: { exitCode: 7, stdout: "command output", stderr: "error" },
    }

    await hook({ tool: "bash" }, output)

    assert.equal(output.args.command, "rtk false")
    assert.deepEqual(output.result, { exitCode: 7, stdout: "command output", stderr: "error" })
  })
})
