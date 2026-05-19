/*
 * plugin-self-check.test.ts — unit tests for the
 * `runSelfCheckIfNeeded` / `getSelfCheckResult` pair (task 4.4
 * of .kiro/specs/session-compaction).
 *
 * Covers design §Testing Strategy / Unit Tests #8: a missing SDK
 * method must flip the module-scoped `selfCheckResult` flag to
 * `"failed"`, the failure must be logged once at `level: "error"`
 * carrying the list of gaps under `extra.missing`, and every
 * subsequent invocation must short-circuit on the cached result
 * without re-probing or re-logging.
 *
 * Requirements covered: R7.2 (self-check on first event),
 * R7.4 (handlers short-circuit on a failed self-check, which is
 * the observable downstream of the cached flag).
 *
 * Runner: `node --test` via the `opencode-cost-diagnosis-node`
 * wrapper. Node 22 with `--experimental-strip-types` strips type
 * annotations at load time and imports the .ts source module
 * directly.
 *
 * Module-state caveat
 * -------------------
 * `selfCheckResult` is module-scoped, initialised to `null`, and
 * latched on first probe. The SUT exposes no reset helper — by
 * design (R7.4: once disabled, stays disabled for the process
 * lifetime). Inside a single test file all `it()` blocks share
 * the same module instance, so we cannot test both the
 * `"ok"`-first and `"failed"`-first transitions in one file.
 *
 * This file pins the failure path as the first probe because
 * task 4.4 explicitly calls out "missing SDK method flips
 * `disabled` flag; handlers short-circuit thereafter". The
 * `"ok"` first-transition is covered indirectly: it is the
 * branch every other unit test in this directory exercises by
 * passing a fully-shaped mock client through other modules, and
 * it is the steady-state branch the Phase 5 integration tests
 * run under. The cached-`"failed"` semantics observed here imply
 * the symmetric cached-`"ok"` semantics by the same code path
 * (the early-return at the top of `runSelfCheckIfNeeded` does
 * not distinguish between the two terminal values).
 *
 * Per-gap variant caveat
 * ----------------------
 * Because the first probe latches, we can only assert the
 * `missing` array for one specific gap shape. We pick
 * `session.summarize` since it is the SDK surface the
 * CompactionInvoker depends on and therefore the gap with the
 * sharpest operator-visible impact. Other per-method gaps
 * (`session.get`, `app.log`, `tui.showToast`) share the same
 * `typeof === "function"` probe path and are covered by code
 * review of the SUT plus the Phase 5 integration tests.
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"

import {
  getSelfCheckResult,
  runSelfCheckIfNeeded,
  type PluginClient,
} from "../../home-manager/common/session-compaction-internal/session-compaction-impl.ts"

// Shape of the `body` payload `runSelfCheckIfNeeded` passes to
// `client.app.log`. Mirrors the inline type in `PluginClient`;
// duplicated locally so the test file does not depend on a
// non-exported alias from the SUT.
interface CapturedLog {
  readonly service: string
  readonly level: "info" | "warn" | "error" | "debug"
  readonly message: string
  readonly extra?: Record<string, unknown>
}

// Build a `PluginClient` that omits `session.summarize` to trip
// the probe. The other three surfaces (`session.get`, `app.log`,
// `tui.showToast`) are present so the `missing` array contains
// exactly one entry — the one we assert on.
//
// The double cast through `unknown` is the same escape hatch the
// SUT uses to bridge opencode's runtime `Client` into the local
// `PluginClient` view (see session-compaction.ts:1408–1413). It
// is the minimum disturbance required to mock a deliberately
// partial shape without weakening the `PluginClient` contract
// itself.
function makePartialClient(): {
  readonly client: PluginClient
  readonly logs: CapturedLog[]
} {
  const logs: CapturedLog[] = []
  const client = {
    session: {
      // `summarize` intentionally omitted.
      get: async (_params: { readonly path: { readonly id: string } }) => ({}),
    },
    app: {
      log: async (params: { readonly body: CapturedLog }) => {
        logs.push(params.body)
        return true
      },
    },
    tui: {
      showToast: async (_params: {
        readonly body: {
          readonly message: string
          readonly variant: "info" | "success" | "warning" | "error"
        }
      }) => true,
    },
  } as unknown as PluginClient
  return { client, logs }
}

describe("PluginSelfCheck", () => {
  // NOTE: This must be the literal first observation in the
  // file. If any earlier statement in this module invoked
  // `runSelfCheckIfNeeded`, the latch would already have moved
  // off `null` and this assertion would falsely fail. The
  // imports above are pure (no side-effects in the SUT's
  // top-level), so the latch is guaranteed `null` on first read.
  it("initial selfCheckResult is null before any call", () => {
    assert.equal(getSelfCheckResult(), null)
  })

  it("partial client (missing session.summarize) flips the latch to 'failed' and emits one error log", async () => {
    const { client, logs } = makePartialClient()

    const result = await runSelfCheckIfNeeded(client)

    assert.equal(result, "failed")
    assert.equal(getSelfCheckResult(), "failed")

    // Exactly one log entry, at error level, from the
    // session-compaction service.
    assert.equal(logs.length, 1)
    const entry = logs[0]
    assert.equal(entry.service, "session-compaction")
    assert.equal(entry.level, "error")
    assert.equal(entry.message, "self-check failed")

    // `extra.missing` is an array carrying every gap. We
    // omitted exactly one surface, so the array length is 1
    // and the entry names the omitted method.
    const missing = entry.extra?.missing
    assert.ok(
      Array.isArray(missing),
      `expected extra.missing to be an array; got ${typeof missing}`,
    )
    assert.equal(missing.length, 1)
    assert.equal(missing[0], "session.summarize")
  })

  it("subsequent call short-circuits on cached 'failed' without re-probing or re-logging", async () => {
    const { client, logs } = makePartialClient()

    const result = await runSelfCheckIfNeeded(client)

    // Cache wins: still "failed".
    assert.equal(result, "failed")
    assert.equal(getSelfCheckResult(), "failed")

    // The freshly-constructed mock's log sink saw zero
    // emissions — the SUT returned at the early `if
    // (selfCheckResult !== null) return selfCheckResult` and
    // never reached `logSelfCheck`.
    assert.equal(logs.length, 0)
  })

  it("calling with a fully-shaped client after the failure latches still returns 'failed' (idempotent)", async () => {
    // A complete client. The cache must win regardless of how
    // intact this one is — this is the R7.4 short-circuit
    // observable: once disabled, downstream handlers see the
    // same `"failed"` flag no matter which client they pass.
    const logs: CapturedLog[] = []
    const completeClient = {
      session: {
        summarize: async (_params: {
          readonly path: { readonly id: string }
          readonly body: Record<string, unknown>
        }) => true,
        get: async (_params: { readonly path: { readonly id: string } }) => ({}),
      },
      app: {
        log: async (params: { readonly body: CapturedLog }) => {
          logs.push(params.body)
          return true
        },
      },
      tui: {
        showToast: async (_params: {
          readonly body: {
            readonly message: string
            readonly variant: "info" | "success" | "warning" | "error"
          }
        }) => true,
      },
    } as unknown as PluginClient

    const result = await runSelfCheckIfNeeded(completeClient)

    assert.equal(result, "failed")
    assert.equal(getSelfCheckResult(), "failed")
    assert.equal(logs.length, 0)
  })
})
