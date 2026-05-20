/*
 * subagent-gating.test.ts — end-to-end integration test for the
 * subagent-watch trichotomy (task 5.4 of
 * .kiro/specs/session-compaction).
 *
 * Covers design §Testing Strategy / Integration Tests #4 and #5,
 * exercising the impl module's `session.created` gating logic
 * (R5.2, R5.3, R5.5) and the env-var → parser contract for
 * `SESSION_COMPACTION_SUBAGENT_ALLOWLIST`. The four scenarios:
 *
 *   (a) `watchSubagents=false` (R5.2) — a subagent session is
 *       added to `ignoredSessions`; `message.updated` past
 *       threshold does NOT invoke `client.session.summarize`.
 *   (b) `watchSubagents=true`, allowlist `match-any` (env var
 *       empty) (R5.3) — any subagent type is in scope; threshold
 *       trip fires exactly one summarize call.
 *   (c) `watchSubagents=true`, allowlist `match-listed =
 *       ["yb-sleuth"]` (R5.5) — `yb-sleuth` subagent triggers
 *       compaction; `explore` subagent is ignored. Tests both
 *       allowlist hit and allowlist miss in a single config.
 *   (d) `watchSubagents=true`, allowlist `match-none` sentinel
 *       `"__MATCH_NONE__"` (R5.5) — every subagent is ignored;
 *       threshold trip does NOT fire summarize. Proves the Nix
 *       module's empty-list sentinel survives the env-var
 *       boundary into the plugin's `parseSubagentAllowlist`.
 *
 * Per-scenario subprocess isolation
 * ---------------------------------
 * The impl module has three module-scoped latches that persist
 * for the lifetime of a Node process:
 *
 *   - `pluginConfig` — set on first `getOrLoadConfig()` call from
 *     `loadConfigFromEnv()`; subsequent reads return the cached
 *     snapshot. Different env vars across scenarios produce
 *     different configs, which CANNOT coexist in one process.
 *   - `ignoredSessions: Set<string>` — accumulated across
 *     `session.created` events; we want scenario (c) to share
 *     this set (one in / one out) but scenarios (a)/(b)/(d)
 *     must start with it empty.
 *   - `selfCheckResult` — latched on first event; reuses a
 *     `"failed"` outcome would short-circuit subsequent handlers.
 *
 * Therefore each scenario runs in its own Node subprocess
 * spawned from a tempdir runner script. The parent test asserts
 * subprocess exit code is 0; on failure, the runner's stderr is
 * surfaced verbatim so a regression is debuggable.
 *
 * Tempdir runner pattern (in-boundary)
 * ------------------------------------
 * The runner is a single `.mjs` file written to a tempdir at
 * `before()` and removed at `after()`. This mirrors the pattern
 * `cavemem-context-source.test.ts` uses to install fake `cavemem`
 * shell scripts on PATH: a runtime artifact written via
 * `writeFileSync` is treated as fixture material, NOT as a
 * separate source file. The task's `_Boundary:_` therefore
 * remains a single test file.
 *
 * The runner switches on a `SCENARIO` env var (`"a"|"b"|"c"|"d"`)
 * and an `IMPL_PATH` env var (absolute path to the impl module).
 * It builds the mock client inline, drives the appropriate
 * handlers, and asserts via `node:assert`. Successful runs exit
 * 0; assertion failures emit the error message and stack to
 * stderr then exit 1.
 *
 * Node 22 TypeScript loading
 * --------------------------
 * Node 22.18+ strips type annotations from `.ts` files by
 * default at import time. The subprocess dynamically imports the
 * impl module (`.ts`) via an absolute path, and we pass
 * `NODE_OPTIONS=--experimental-strip-types` to be defensive
 * against a future opt-out flag flip. The runner file itself is
 * `.mjs` (plain ESM JS) so its own syntax requires no stripping.
 *
 * Runner: `node --test` via `opencode-cost-diagnosis-node`. The
 * parent test file is run by the harness's worker; each `it()`
 * spawns one additional Node subprocess via
 * `node:child_process.spawn`. No other side effects.
 */

import { describe, it, before, after } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------
// Paths
// ---------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))

// Absolute path to the impl module — passed to the subprocess
// runner via env var so the runner does not depend on its own
// `__dirname` (the runner lives in a tempdir, not under the
// repo root).
const IMPL_PATH = resolve(
  __dirname,
  "../../../home-manager/common/session-compaction-internal/session-compaction-impl.ts",
)

// ---------------------------------------------------------------
// Runner source
// ---------------------------------------------------------------
//
// The runner is a single ESM script that switches on the
// `SCENARIO` env var and exits 0 on assertion success / 1 on
// failure. Each subprocess gets a fresh Node, a fresh impl
// module, and a fresh mock client.
//
// Mock client shape (impl reads):
//   - session.summarize(params) — captured into summarizeCalls
//   - session.get({ path: { id } }) — returns the pre-registered
//     `{ parentID, agent, time: { compacting } }` for that id,
//     or a benign main-thread default. The `parentID` field is
//     the discriminator: non-null → subagent (impl line ~1492).
//   - app.log(params) — accepted (presence required for self-
//     check to latch `"ok"`).
//   - tui.showToast(params) — accepted.
//
// AssistantMessage token math: `tokens.input(100) +
// tokens.cache.read(200) = 300`. With
// SESSION_COMPACTION_THRESHOLD_TOKENS=100 every scenario sees
// 300 > 100 on the first AssistantMessage, so the only thing
// gating compaction is the subagent-watch / allowlist logic.

const RUNNER_SOURCE = `import { strict as assert } from "node:assert"

const implPath = process.env.IMPL_PATH
const scenario = process.env.SCENARIO
if (!implPath || !scenario) {
  console.error("runner missing IMPL_PATH or SCENARIO env var")
  process.exit(1)
}

function makeMockClient() {
  const summarizeCalls = []
  const logs = []
  // sessionGetReturns lets the test pre-register the shape
  // session.get returns for a given sessionID. Unregistered IDs
  // fall back to a main-thread default (parentID=null), which is
  // safe because every scenario pre-registers every ID it uses.
  const sessionGetReturns = new Map()
  const client = {
    session: {
      summarize: async (params) => {
        summarizeCalls.push({ id: params.path.id, body: params.body })
        return true
      },
      get: async (params) => {
        const m = sessionGetReturns.get(params.path.id)
        if (m) return m
        return { parentID: null, agent: null, time: { compacting: null } }
      },
    },
    app: {
      log: async (params) => { logs.push(params.body); return true },
    },
    tui: {
      showToast: async () => true,
    },
  }
  return { client, summarizeCalls, logs, sessionGetReturns }
}

function assistantMessage(sessionID, messageID) {
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

try {
  const impl = await import(implPath)
  const { createHooks, isSessionIgnored } = impl

  const harness = makeMockClient()
  const hooks = createHooks(harness.client)

  if (scenario === "a") {
    // (a) watchSubagents=false: subagent must be ignored; no
    // summarize call past threshold (R5.2).
    const id = "ses_scenario_a_subagent"
    harness.sessionGetReturns.set(id, {
      parentID: "ses_parent_main",
      agent: "yb-sleuth",
      time: { compacting: null },
    })
    await hooks["session.created"]({ info: { id } })
    assert.equal(
      isSessionIgnored(id), true,
      "(a) subagent must be in ignoredSessions when watchSubagents=0",
    )
    await hooks["message.updated"]({ info: assistantMessage(id, "msg_a") })
    assert.equal(
      harness.summarizeCalls.length, 0,
      \`(a) expected 0 summarize calls for ignored subagent; got \${harness.summarizeCalls.length}\`,
    )
  } else if (scenario === "b") {
    // (b) watchSubagents=true, allowlist match-any: any subagent
    // type fires (R5.3). Allowlist env var is empty string →
    // parseSubagentAllowlist returns { kind: "match-any" }.
    const id = "ses_scenario_b_subagent"
    harness.sessionGetReturns.set(id, {
      parentID: "ses_parent_main",
      agent: "any-agent-type",
      time: { compacting: null },
    })
    await hooks["session.created"]({ info: { id } })
    assert.equal(
      isSessionIgnored(id), false,
      "(b) match-any must NOT ignore subagent",
    )
    await hooks["message.updated"]({ info: assistantMessage(id, "msg_b") })
    assert.equal(
      harness.summarizeCalls.length, 1,
      \`(b) expected exactly 1 summarize call for watched subagent; got \${harness.summarizeCalls.length}\`,
    )
    assert.equal(
      harness.summarizeCalls[0].id, id,
      \`(b) summarize must target the subagent's sessionID; got \${harness.summarizeCalls[0].id}\`,
    )
  } else if (scenario === "c") {
    // (c) watchSubagents=true, allowlist=["yb-sleuth"]: hit fires
    // (yb-sleuth); miss is ignored (explore) (R5.5). Both
    // sessions share the same plugin config since they run in
    // one subprocess — the predicate is per-session via the
    // allowlist match, not via separate configs.
    const allowedId = "ses_scenario_c_ybsleuth"
    const deniedId = "ses_scenario_c_explore"
    harness.sessionGetReturns.set(allowedId, {
      parentID: "ses_parent_main",
      agent: "yb-sleuth",
      time: { compacting: null },
    })
    harness.sessionGetReturns.set(deniedId, {
      parentID: "ses_parent_main",
      agent: "explore",
      time: { compacting: null },
    })
    await hooks["session.created"]({ info: { id: allowedId } })
    await hooks["session.created"]({ info: { id: deniedId } })
    assert.equal(
      isSessionIgnored(allowedId), false,
      "(c) yb-sleuth (on allowlist) must NOT be ignored",
    )
    assert.equal(
      isSessionIgnored(deniedId), true,
      "(c) explore (off allowlist) must be ignored",
    )
    await hooks["message.updated"]({ info: assistantMessage(allowedId, "msg_c_yb") })
    await hooks["message.updated"]({ info: assistantMessage(deniedId, "msg_c_ex") })
    assert.equal(
      harness.summarizeCalls.length, 1,
      \`(c) expected exactly 1 summarize call (yb-sleuth only); got \${harness.summarizeCalls.length}, ids=\${JSON.stringify(harness.summarizeCalls.map((c) => c.id))}\`,
    )
    assert.equal(
      harness.summarizeCalls[0].id, allowedId,
      \`(c) summarize must target yb-sleuth, not explore; got \${harness.summarizeCalls[0].id}\`,
    )
  } else if (scenario === "d") {
    // (d) watchSubagents=true, allowlist match-none sentinel:
    // every subagent ignored. Verifies the Nix → env-var →
    // parser contract end-to-end: the literal string
    // "__MATCH_NONE__" emitted by the Nix module (task 1.3) is
    // honored by parseSubagentAllowlist (impl line ~1296).
    const id = "ses_scenario_d_subagent"
    harness.sessionGetReturns.set(id, {
      parentID: "ses_parent_main",
      agent: "yb-sleuth",
      time: { compacting: null },
    })
    await hooks["session.created"]({ info: { id } })
    assert.equal(
      isSessionIgnored(id), true,
      "(d) __MATCH_NONE__ sentinel must cause every subagent to be ignored",
    )
    await hooks["message.updated"]({ info: assistantMessage(id, "msg_d") })
    assert.equal(
      harness.summarizeCalls.length, 0,
      \`(d) expected 0 summarize calls under match-none; got \${harness.summarizeCalls.length}\`,
    )
  } else {
    throw new Error("unknown SCENARIO: " + scenario)
  }

  process.exit(0)
} catch (err) {
  const msg = err && err.message ? err.message : String(err)
  console.error("runner assertion failed:", msg)
  if (err && err.stack) console.error(err.stack)
  process.exit(1)
}
`

// ---------------------------------------------------------------
// Subprocess driver
// ---------------------------------------------------------------

interface RunResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/**
 * Spawn a fresh Node subprocess executing the runner with the
 * supplied env. The subprocess inherits the parent's PATH so it
 * uses the same Node binary the test runner is using. We pass
 * `NODE_OPTIONS=--experimental-strip-types` so the runner can
 * dynamically import the impl module's `.ts` source even if a
 * future Node release flips strip-types off by default.
 *
 * Returns the captured exit code plus stdout/stderr so the
 * parent assertion can surface the runner's failure message
 * verbatim. Resolves only after the child fully exits.
 */
function runScenario(
  runnerPath: string,
  scenarioEnv: Record<string, string>,
): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [runnerPath], {
      env: {
        ...process.env,
        ...scenarioEnv,
        IMPL_PATH,
        NODE_OPTIONS: "--experimental-strip-types",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    child.on("error", rej)
    child.on("exit", (code) => {
      res({ exitCode: code, stdout, stderr })
    })
  })
}

// ---------------------------------------------------------------
// Tempdir lifecycle
// ---------------------------------------------------------------

let tmpDir: string
let runnerPath: string

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "session-compaction-subagent-"))
  runnerPath = join(tmpDir, "runner.mjs")
  writeFileSync(runnerPath, RUNNER_SOURCE, "utf8")
})

after(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("subagent gating + allowlist trichotomy — R5.2, R5.3, R5.5", () => {
  it("(a) watchSubagents=false: subagent does NOT trigger compaction past threshold (R5.2)", async () => {
    const result = await runScenario(runnerPath, {
      SCENARIO: "a",
      SESSION_COMPACTION_WATCH_SUBAGENTS: "0",
      SESSION_COMPACTION_THRESHOLD_TOKENS: "100",
    })
    assert.equal(
      result.exitCode,
      0,
      `scenario (a) failed (exit=${result.exitCode}):\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  })

  it("(b) watchSubagents=true, allowlist match-any (empty env var): any subagent type triggers (R5.3)", async () => {
    const result = await runScenario(runnerPath, {
      SCENARIO: "b",
      SESSION_COMPACTION_WATCH_SUBAGENTS: "1",
      SESSION_COMPACTION_THRESHOLD_TOKENS: "100",
      // Empty string == match-any per parseSubagentAllowlist.
      SESSION_COMPACTION_SUBAGENT_ALLOWLIST: "",
    })
    assert.equal(
      result.exitCode,
      0,
      `scenario (b) failed (exit=${result.exitCode}):\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  })

  it("(c) watchSubagents=true, allowlist=['yb-sleuth']: yb-sleuth fires, explore is ignored (R5.5)", async () => {
    const result = await runScenario(runnerPath, {
      SCENARIO: "c",
      SESSION_COMPACTION_WATCH_SUBAGENTS: "1",
      SESSION_COMPACTION_THRESHOLD_TOKENS: "100",
      SESSION_COMPACTION_SUBAGENT_ALLOWLIST: "yb-sleuth",
    })
    assert.equal(
      result.exitCode,
      0,
      `scenario (c) failed (exit=${result.exitCode}):\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  })

  it("(d) watchSubagents=true, allowlist=__MATCH_NONE__ sentinel: NO subagent triggers (R5.5; Nix → env-var → parser)", async () => {
    const result = await runScenario(runnerPath, {
      SCENARIO: "d",
      SESSION_COMPACTION_WATCH_SUBAGENTS: "1",
      SESSION_COMPACTION_THRESHOLD_TOKENS: "100",
      SESSION_COMPACTION_SUBAGENT_ALLOWLIST: "__MATCH_NONE__",
    })
    assert.equal(
      result.exitCode,
      0,
      `scenario (d) failed (exit=${result.exitCode}):\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  })
})
