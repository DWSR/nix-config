/*
 * cavemem-context-source.test.ts — unit tests for the
 * CavememContextSource seam (task 2.5 of
 * .kiro/specs/session-compaction).
 *
 * Covers design §Testing Strategy / Unit Tests #6–#7:
 *   #6 timeout produces empty result (SIGTERM bound by the
 *      configurable timeout; never throws — R3.3)
 *   #7 never writes: the only subcommand invoked is `cavemem
 *      search` with read-only flags (R3.4, R8.4)
 *
 * The SUT (`fetchCavememContext`) spawns `cavemem` directly via
 * `node:child_process.spawn`. To avoid modifying the source, we
 * substitute a fake `cavemem` shell script by prepending a
 * temporary directory to `process.env.PATH`. Each test installs
 * its own fake-cavemem with bespoke behavior (echo, sleep, exit
 * non-zero, log argv) and restores PATH on teardown.
 *
 * Runner: `node --test` via the `opencode-cost-diagnosis-node`
 * wrapper; the dev wrapper wires up the vendored dev-deps tree
 * via NODE_PATH. The file is `.ts`; Node 22 with
 * `--experimental-strip-types` strips type annotations at load
 * time and imports the .ts source module directly.
 *
 * Determinism / hermeticity:
 *   - Tests within a single `node:test` file run serially, so
 *     mutating `process.env.PATH` between tests is safe.
 *   - Every test wraps state mutation in try/finally so PATH
 *     and `SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS` are restored
 *     even on assertion failure.
 *   - The fake cavemem's `#!/usr/bin/env bash` shebang loads
 *     `bash` via `/usr/bin/env`, whose path is fixed and not
 *     affected by our PATH override; bash itself locates
 *     coreutils (`echo`, `sleep`, `seq`) via the preserved
 *     original PATH.
 */

import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fetchCavememContext } from "../../home-manager/common/opencode-plugins/session-compaction.ts"

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

interface FakeCavemem {
  readonly dir: string
  readonly originalPath: string
  readonly cleanup: () => void
}

/**
 * Build a temporary directory containing an executable `cavemem`
 * shell script with the supplied body, then prepend the tempdir
 * to PATH so the SUT's `spawn("cavemem", ...)` resolves to our
 * fake. Returns a cleanup callback that restores PATH and removes
 * the tempdir; callers MUST invoke it in a `finally` block.
 *
 * The `mode: 0o755` arg to `writeFileSync` is filtered by the
 * process umask, so `chmodSync` afterwards is the canonical
 * source of truth for executability.
 */
function makeFakeCavemem(scriptBody: string): FakeCavemem {
  const dir = mkdtempSync(join(tmpdir(), "session-compaction-fake-"))
  const fakePath = join(dir, "cavemem")
  writeFileSync(
    fakePath,
    `#!/usr/bin/env bash\n${scriptBody}\n`,
    { mode: 0o755 },
  )
  chmodSync(fakePath, 0o755)
  const originalPath = process.env.PATH ?? ""
  process.env.PATH = `${dir}:${originalPath}`
  return {
    dir,
    originalPath,
    cleanup: (): void => {
      process.env.PATH = originalPath
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Save the current `SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS` env
 * var, overwrite it, and return a restore callback. The SUT
 * reads this env var via `resolveCavememTimeoutMillis()` at
 * each `fetchCavememContext` call, so the override is observed
 * immediately without re-importing the module.
 */
function overrideTimeoutEnv(value: string): () => void {
  const previous = process.env.SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS
  process.env.SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS = value
  return (): void => {
    if (previous === undefined) {
      delete process.env.SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS
    } else {
      process.env.SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS = previous
    }
  }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe("fetchCavememContext — happy path", () => {
  it("non-empty stdout populates text and source", async () => {
    const fake = makeFakeCavemem(`echo "decisions: chose X; current focus: Y"`)
    try {
      const result = await fetchCavememContext("ses_test")
      assert.ok(
        result.text.includes("decisions"),
        `expected stdout to flow through; got: ${JSON.stringify(result.text)}`,
      )
      assert.equal(result.source, "cavemem search")
      assert.ok(
        result.elapsedMillis >= 0,
        `elapsedMillis must be non-negative; got ${result.elapsedMillis}`,
      )
    } finally {
      fake.cleanup()
    }
  })

  it("empty stdout with zero exit still marks success via non-empty source", async () => {
    // Contract from SUT docstring: "Subprocess exits zero with
    // empty stdout → { text: '', source: 'cavemem search' }".
    // A successful call returning no payload is distinguishable
    // from a failure by the non-empty `source`.
    const fake = makeFakeCavemem(`exit 0`)
    try {
      const result = await fetchCavememContext("ses_test")
      assert.equal(result.text, "")
      assert.equal(result.source, "cavemem search")
    } finally {
      fake.cleanup()
    }
  })
})

describe("fetchCavememContext — R3.3 failure paths return empty without throwing", () => {
  it("non-zero exit returns empty text AND empty source", async () => {
    // Failure-vs-success disambiguator: source is empty on
    // failure paths. Stderr is discarded by the SUT
    // (`stdio[2] = "ignore"`), so even if the fake writes to
    // stderr the caller never sees it.
    const fake = makeFakeCavemem(`echo "would be output" >&2; exit 1`)
    try {
      const result = await fetchCavememContext("ses_test")
      assert.equal(result.text, "")
      assert.equal(result.source, "")
    } finally {
      fake.cleanup()
    }
  })

  it("timeout SIGTERMs slow subprocess and returns empty (R3.3)", async () => {
    // Configure a 200ms timeout, then make the fake sleep
    // longer than that. The SUT must kill the child and
    // resolve empty before the subprocess would naturally
    // finish.
    const fake = makeFakeCavemem(`sleep 10; echo "would be output"`)
    const restoreTimeout = overrideTimeoutEnv("200")
    try {
      const start = Date.now()
      const result = await fetchCavememContext("ses_test")
      const elapsed = Date.now() - start
      assert.equal(result.text, "")
      assert.equal(result.source, "")
      assert.ok(
        elapsed < 2000,
        `timeout should fire well before subprocess natural exit; got ${elapsed}ms`,
      )
      assert.ok(
        elapsed >= 150,
        `should not return faster than the configured 200ms timeout; got ${elapsed}ms`,
      )
    } finally {
      restoreTimeout()
      fake.cleanup()
    }
  })

  it("spawn-fail (binary not on PATH) returns empty quickly without throwing", async () => {
    // Direct PATH override (no fake cavemem). ENOENT surfaces
    // via the async 'error' event handler in the SUT, which
    // resolves empty. This is the most common real-world
    // failure mode (cavemem not installed) — must be fast.
    const originalPath = process.env.PATH ?? ""
    process.env.PATH = "/nowhere-no-cavemem"
    try {
      const start = Date.now()
      const result = await fetchCavememContext("ses_test")
      const elapsed = Date.now() - start
      assert.equal(result.text, "")
      assert.equal(result.source, "")
      assert.ok(
        elapsed < 500,
        `spawn-fail should return quickly; got ${elapsed}ms`,
      )
    } finally {
      process.env.PATH = originalPath
    }
  })
})

describe("fetchCavememContext — R3.4, R8.4 read-only invocation contract", () => {
  it("only the 'search' subcommand is invoked, with sessionID and limit", async () => {
    // Fake cavemem captures its argv to a sibling file inside
    // its tempdir so we can introspect what the SUT actually
    // passed. Asserts: (a) first positional is "search"; (b)
    // the caller-supplied sessionID flows through; (c) the
    // limit flag flows through; (d) no write-class subcommand
    // (write/import/hook/remove/delete/update) appears anywhere
    // in argv.
    const fake = makeFakeCavemem("") // body filled below
    try {
      const argFile = join(fake.dir, "argv.log")
      const fakePath = join(fake.dir, "cavemem")
      writeFileSync(
        fakePath,
        `#!/usr/bin/env bash\necho "$@" > "${argFile}"\necho "result"\n`,
        { mode: 0o755 },
      )
      chmodSync(fakePath, 0o755)

      await fetchCavememContext("ses_specific_id", 5)

      assert.ok(
        existsSync(argFile),
        "fake cavemem should have logged its argv",
      )
      const args = readFileSync(argFile, "utf8").trim()
      assert.ok(
        args.startsWith("search "),
        `first positional must be 'search'; got: ${JSON.stringify(args)}`,
      )
      assert.ok(
        args.includes("ses_specific_id"),
        `sessionID must be forwarded; got: ${JSON.stringify(args)}`,
      )
      assert.ok(
        args.includes("--limit 5"),
        `--limit must carry the caller-supplied value; got: ${JSON.stringify(args)}`,
      )
      assert.ok(
        args.includes("--session"),
        `--session flag must be present; got: ${JSON.stringify(args)}`,
      )
      // Negative assertions: NO write-class subcommand may appear.
      // The blocklist enumerates every cavemem subcommand that
      // mutates state. If cavemem grows a new write subcommand,
      // this test should be extended.
      for (const forbidden of [
        "write",
        "import",
        "hook",
        "remove",
        "delete",
        "update",
        "create",
        "set",
      ]) {
        assert.ok(
          !args.includes(forbidden),
          `forbidden write-class token '${forbidden}' must not appear in argv; got: ${JSON.stringify(args)}`,
        )
      }
    } finally {
      fake.cleanup()
    }
  })

  it("uses the default limit when caller omits the argument", async () => {
    // Documents the default-limit contract from the SUT's
    // `CAVEMEM_DEFAULT_LIMIT = 10` constant: omitting the limit
    // parameter forwards `--limit 10`, not `--limit undefined`
    // or a missing flag.
    const fake = makeFakeCavemem("")
    try {
      const argFile = join(fake.dir, "argv.log")
      const fakePath = join(fake.dir, "cavemem")
      writeFileSync(
        fakePath,
        `#!/usr/bin/env bash\necho "$@" > "${argFile}"\nexit 0\n`,
        { mode: 0o755 },
      )
      chmodSync(fakePath, 0o755)

      await fetchCavememContext("ses_default_limit")

      const args = readFileSync(argFile, "utf8").trim()
      assert.ok(
        args.includes("--limit 10"),
        `default --limit 10 must be forwarded when caller omits limit; got: ${JSON.stringify(args)}`,
      )
    } finally {
      fake.cleanup()
    }
  })
})

describe("fetchCavememContext — 4KB stdout cap", () => {
  it("truncates stdout at the cap and appends the truncation marker", async () => {
    // 100 lines × 92 bytes ≈ 9200 bytes of stdout, well over
    // the 4096-byte cap. The SUT must slice at the cap and
    // append "…[truncated]". Note: result.text.length is a
    // char count (not bytes); the cap is in bytes and the
    // marker contains one 3-byte UTF-8 ellipsis, so the
    // resulting char count is a few less than 4096 + marker
    // chars, well under the conservative 4096 + 50 bound.
    const fake = makeFakeCavemem(`for i in $(seq 1 100); do
  echo "0123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890"
done`)
    try {
      const result = await fetchCavememContext("ses_truncation")
      assert.equal(result.source, "cavemem search")
      assert.ok(
        result.text.length <= 4096 + 50,
        `text should be at or near 4KB cap; got ${result.text.length} chars`,
      )
      assert.ok(
        result.text.endsWith("…[truncated]"),
        `expected truncation marker suffix; tail: ${JSON.stringify(result.text.slice(-30))}`,
      )
    } finally {
      fake.cleanup()
    }
  })
})
