import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  RTK_PLUGIN_SERVICE,
  RtkPlugin,
  type AppLogBody,
  type RtkPluginEnvironment,
} from "../../home-manager/common/opencode-plugins/rtk.ts"

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
