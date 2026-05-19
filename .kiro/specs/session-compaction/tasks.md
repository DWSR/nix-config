# Implementation Plan

This plan delivers the `session-compaction` opencode plugin per
`design.md`. Foundation (Phase 1) lands working stubs on PATH on both
nix-darwin hosts before any plugin logic is implemented — by end of
task 1.5, `darwin-rebuild switch` produces a loaded-but-inert plugin
that passes opencode's startup checks. The plugin's six internal
seams (Phase 2 Core) fill in sequentially because they all live in
the same TS file (`home-manager/common/opencode-plugins/session-
compaction.ts`); concurrent edits would conflict. Integration
(Phase 3) wires those seams to event handlers, the slash command,
and the augmentation hook. Validation phases (4–7) cover unit tests
(parallel — separate test files), integration tests (parallel —
separate test files), the steering doc + manual baseline-and-replay
procedure from design's §Testing Strategy, and a composition smoke
to confirm coexistence with `opencode-cost-diagnosis`.

**Intentionally deferred (documented as design-phase follow-ups,
not blocking spec completion)**:
- Deterministic replay harness for R9.2 (design §Testing Strategy
  "Replay harness follow-up" — initial validation runs use live
  re-execution).
- Empirical confirmation of `Session.time.compacting` persistence
  semantics (design §Logical Data Model) — verified during task 3.6
  with fallback to plugin-side `lastCompactionAt` documented as the
  remediation if persistence does not hold.

## Tasks

- [ ] 1. Foundation: install pipeline and plugin loading

- [x] 1.1 Stub plugin file with type-safe empty handlers
  - Create `home-manager/common/opencode-plugins/session-compaction.ts`
    importing `Plugin` from `@opencode-ai/plugin`
  - Export `SessionCompactionPlugin: Plugin = async (ctx) => ({})` —
    returns an empty handler object so opencode loads the plugin
    without error; no logic yet
  - File must satisfy TS strict-mode and never use `any`
  - Observable: after task 1.4 is wired, `opencode --version` runs
    to completion with the plugin file symlinked into
    `~/.config/opencode/plugins/` and no plugin-load errors in
    opencode's startup log
  - _Requirements: 1.2, 1.4, 7.6_

- [x] 1.2 Stub slash command markdown
  - Create `home-manager/common/commands/compact.md` with frontmatter
    `description: Trigger session compaction` and a short LLM-readable
    body indicating the session-compaction plugin will execute the
    operation (no LLM-side instructions for invoking the SDK; the
    plugin's `command.executed` handler is the actual mechanism, per
    design §Components / SlashCommand)
  - Observable: file exists at the documented path with parseable
    frontmatter; opencode renders it in the `/?` command list after
    task 1.4 lands
  - _Requirements: 4.1_

- [x] 1.3 Create HM module with options and peer assertion
  - Create `home-manager/common/session-compaction.nix` mirroring
    `home-manager/common/opencode-cost-diagnosis.nix:1-141` structure
  - Expose `programs.session-compaction` option attrset with all
    seven options exactly as defined in design §Components /
    SessionCompactionModule / Module Options: `enable`,
    `thresholdTokens`, `thresholdWallTimeHours`, `cooldownMinutes`,
    `augmentationEnabled`, `watchSubagents`, `subagentAllowlist`,
    `cavememContextTimeoutMillis`
  - Implement the subagent-allowlist trichotomy via conditional env-var
    emission in `home.opencode.wrapperCommands` (null → omit the env
    var entirely; `[]` → export `__MATCH_NONE__`; `[a,b,c]` → export
    `a,b,c`) per design §Install Steps
  - Add `assertion = config.programs.opencode.enable` with the
    documented actionable error message
  - Implement `config = lib.mkIf cfg.enable { … }` wiring
    `xdg.configFile."opencode/plugins/session-compaction.ts".source`
    and `programs.opencode.commands.compact = ./commands/compact.md`
  - Observable: `nix flake check` passes; with the module disabled,
    no plugin symlink appears under `~/.config/opencode/plugins/`;
    enabling without `programs.opencode.enable` fails build with the
    documented assertion message
  - _Requirements: 1.3, 1.5, 2.2, 2.4, 2.6, 2.8, 3.6, 4.1, 5.1, 5.4, 7.1, 7.6_

- [x] 1.4 Wire module into common configuration
  - Add `./session-compaction.nix` to the `imports` list in
    `home-manager/common/default.nix` (peer of
    `./opencode-cost-diagnosis.nix`)
  - Enable with `programs.session-compaction.enable = true;` at the
    documented common-module enable location (adjacent to
    `programs.opencode-cost-diagnosis.enable = true;`)
  - Observable: `darwin-rebuild build --flake .#ShopifyLaptop`
    succeeds (or `.#personal-host` equivalent); the resulting toplevel
    derivation references `session-compaction.ts` as a path
  - _Requirements: 1.1, 1.2_

- [x] 1.5 End-to-end install verification on a real host
  - Run `darwin-rebuild switch --flake .#<host>` on at least one host
  - Verify `ls -la ~/.config/opencode/plugins/session-compaction.ts`
    resolves to the in-tree source path
  - Verify `ls ~/.config/opencode/command/compact.md` exists (note
    opencode renders `programs.opencode.commands` into `command/`,
    not `commands/`)
  - Verify the seven `SESSION_COMPACTION_*` env vars are exported in
    a freshly-opened opencode session (inspect via the plugin's
    eventual startup self-log, or via a one-shot
    `opencode session --shell 'env | grep SESSION_COMPACTION'`)
  - Verify `opencode --version` returns 0 with no plugin-load
    errors
  - Record the resolved on-disk location where `client.app.log`
    persists (typically `~/.local/share/opencode/logs/`) so the
    steering doc (task 6.1) can document it (R6.3)
  - Observable: post-switch, opening an opencode session prints no
    plugin errors; the env-var probe confirms all seven
    `SESSION_COMPACTION_*` values reach the plugin runtime
  - _Requirements: 1.1, 1.2, 1.6, 6.3_

- [ ] 2. Core: plugin internal seams (single TS file; sequential)

- [x] 2.1 SessionTokenTracker
  - Implement per-session state as a `Map<sessionID, SessionState>`
    in plugin-module scope; SessionState shape per design §Service
    Interface
  - On `message.updated` (call-site in task 3.2), dedupe by `info.id`
    (messageID); aggregate cumulative `tokens.input +
    tokens.cache.read` per session; track `turnCount` (incremented on
    first sight of each new messageID) and `startedAt` (set on
    `session.created`)
  - Expose pure helpers callable by `ThresholdEvaluator` and the
    handlers: `recordMessage(sessionID, message)`,
    `totalInputTokens(sessionID): number`,
    `turnCount(sessionID): number`,
    `wallTimeMillis(sessionID): number`,
    `resetStartedAt(sessionID, now: number)` (called from the
    `session.compacted` handler in 3.6)
  - Reads opencode's authoritative `Message.tokens` payload directly;
    no re-tokenization
  - Observable: when integrated in 3.2, feeding two distinct
    messageIDs accumulates both totals; feeding the same messageID
    twice with different snapshots keeps only the latest
  - _Requirements: 2.1, 8.5_
  - _Boundary: SessionCompactionPlugin (internal seam)_

- [x] 2.2 ThresholdEvaluator
  - Implement as a pure function: given `SessionState` +
    `ThresholdConfig` + most-recent compaction timestamp from
    `Session.time.compacting`, return `ThresholdDecision = {
    shouldCompact: boolean; reason: string }`
  - Reason strings follow the convention documented in design
    §Service Interface (`tokens_exceeded:520000`, `in_cooldown:380s_remaining`,
    `zero_turns`, `wall_time_exceeded:25h`, `tokens_disabled`,
    `wall_time_disabled`)
  - Honor `null`/`0` disabled values for both `thresholdTokens` and
    `thresholdWallTimeHours`; honor cooldown window; honor
    zero-turn no-op
  - Observable: when wired into 3.2, the same threshold + cumulative
    tokens combination produces `shouldCompact: true` exactly once at
    the boundary and `false` thereafter while cooldown is active
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10_
  - _Boundary: SessionCompactionPlugin (internal seam)_

- [x] 2.3 PluginSelfCheck
  - Runs once on the first received event after plugin load (any
    event type); idempotent per plugin lifecycle
  - Probes presence and basic call-ability of `client.session.summarize`,
    `client.session.get`, `client.app.log`, `client.tui.showToast`
  - On any failure: log structured error at `level: "error"` naming
    the missing or shape-changed surface; set module-scoped
    `selfCheckResult` to `"failed"`
  - All other handlers in 3.x short-circuit on
    `selfCheckResult === "failed"` per R7.4
  - When `watchSubagents = true` but the subagent observability
    path is not exercised (e.g., `client.session.get` returns no
    `parentID` field for a known subagent ID), emit a one-time
    warn-level log per R5.6 and continue with main-thread coverage
    only
  - Observable: on first event after plugin load, `app.log` shows
    a single info-level entry `service: "session-compaction",
    message: "self-check passed"` (or error-level with the gap
    named on failure)
  - _Requirements: 5.6, 7.2, 7.3, 7.4_
  - _Boundary: SessionCompactionPlugin (internal seam)_

- [x] 2.4 CompactionInvoker
  - Wraps `client.session.summarize({ path: { id: sessionID },
    body: {} })` with try/catch
  - On success: register a `CompactionAttempt` in module-scoped
    `inFlightAttempts: Map<sessionID, CompactionAttempt>` for
    later attribution by `session.compacted` handler (3.6);
    emit info-level log `"compaction triggered"` with trigger and
    reason
  - On failure: emit error-level log with `errorMessage`; record
    per-session `lastErrorAt` timestamp; do NOT retry within
    cooldown window
  - Returns `{ attempt, succeeded, error }` so callers can surface
    errors via `tui.showToast` when manually invoked (3.3)
  - Observable: an induced SDK error path produces one error-level
    `app.log` entry with the SDK's `errorMessage`; subsequent
    `message.updated` events for the same session continue without
    re-triggering compaction until cooldown elapses
  - _Requirements: 2.9, 7.5_
  - _Boundary: SessionCompactionPlugin (internal seam)_

- [x] 2.5 CavememContextSource
  - Spawn `cavemem search --session <id> --limit <n>` via Bun `$`
    shell, mirroring the spawn pattern in
    `home-manager/common/opencode-plugins/cavemem.js:46-58`
  - Bound execution by `SESSION_COMPACTION_CAVEMEM_TIMEOUT_MS`
    (default 2000ms); on timeout, kill the subprocess and return
    empty
  - Bound stdout to 4KB; truncate with a marker if larger
  - Return `CavememContextResult = { text, source, elapsedMillis }`
  - Never invokes any cavemem write subcommand (R8.4); the only
    cavemem CLI invocation is `cavemem search` with read-only flags
  - Observable: with cavemem stopped, returns
    `{ text: "", source: "", elapsedMillis < 100 }` (spawn-fail
    path); with a slow cavemem stub, returns empty after the
    configured timeout
  - _Requirements: 3.3, 3.4, 8.4_
  - _Boundary: SessionCompactionPlugin (internal seam)_

- [x] 2.6 SessionCompactionLogger
  - Wraps `client.app.log({ body: { service: "session-compaction",
    level, message, extra } })` per design §Logger Contract
  - Convenience methods covering every emission shape declared in
    the design's Event Contract and Logger Contract:
    `logTrigger(attempt)`, `logSuppression(sessionID, reason)`,
    `logAugmentation(sessionID, source, lengthChars)`,
    `logCompacted(sessionID, trigger)`, `logSelfCheck(result)`,
    `logSessionStart(state, config)`,
    `logSessionIdle(sessionID, summary)`, `logError(sessionID, err)`
  - `extra.trigger` accepts the three-variant union
    `"automatic" | "manual" | "external"`
  - Observable: each emission appears in opencode's `app.log` sink
    at the path recorded in task 1.5; entries carry the
    `service: "session-compaction"` field for grepability
  - _Requirements: 6.2, 6.4, 6.5_
  - _Boundary: SessionCompactionPlugin (internal seam)_

- [ ] 3. Integration: event handlers, slash command, augmentation hook

- [x] 3.1 session.created handler — initialize state, subagent gating
  - Register the named hook `'session.created'` on the plugin's
    return object
  - On each event, call `client.session.get({ path: { id: input.info.id } })`
    to read `parentID` and `agent` fields
  - Initialize a fresh `SessionState` in `SessionTokenTracker`
  - If `parentID` is set AND `watchSubagents = false`: add the
    session to an ignore-set
  - If `parentID` is set AND `watchSubagents = true`: apply the
    `subagentAllowlist` trichotomy parsed in task 1.3 — `match-any`
    accepts all subagent agent names; `match-none` ignores the
    session; `match-listed` accepts only sessions whose agent name
    appears in the list
  - Emit a `logSessionStart` event capturing the active config
    snapshot for the session (R6.5)
  - Observable: integration test 5.4 sees only allowlisted subagent
    sessions trigger compaction; non-allowlisted subagents and (when
    `watchSubagents = false`) all subagents are silently ignored
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 6.5_

- [x] 3.2 message.updated handler — token accumulation + automatic trigger
  - Register `'message.updated'` named hook on the plugin's return
  - Short-circuit if `selfCheckResult === "failed"` or session is in
    the ignore-set from 3.1
  - Pass `input.info` through `SessionTokenTracker.recordMessage`
  - Read `Session.time.compacting` via `client.session.get` to source
    the cooldown signal (design Decision D.7); pass into
    `ThresholdEvaluator`
  - On `shouldCompact: true`:
    `await CompactionInvoker.invoke(sessionID, { trigger: "automatic",
    reason: decision.reason })`
  - On `shouldCompact: false`: emit a `logSuppression(sessionID,
    decision.reason)` (R6.4)
  - Observable: integration test 5.1 sees exactly one
    `client.session.summarize` call after the synthetic message
    sequence crosses the threshold; while cooldown is active, no
    additional calls fire for the same session
  - _Requirements: 2.1, 2.3, 2.5, 2.7, 2.9, 2.10, 6.4_

- [x] 3.3 command.executed handler — manual /compact dispatch
  - Register `'command.executed'` named hook
  - Filter on `input.name === "compact"`; ignore all other commands
  - If `SessionTokenTracker.turnCount(input.sessionID) === 0`:
    emit info-level `logSuppression(sessionID, "zero_turns_manual")`;
    call `client.tui.showToast({ body: { message: "Nothing to
    compact.", variant: "info" } })`; return without invoking summarize
  - Otherwise: `await CompactionInvoker.invoke(sessionID, { trigger:
    "manual", reason: "user_initiated" })`
  - On non-zero error from the invoker: call
    `client.tui.showToast({ body: { message: <error>, variant:
    "error" } })`; do not throw
  - Observable: integration test 5.2 sees the SAME augmentation
    chain (3.4) fire identically to the automatic path; manual
    /compact on a zero-turn session produces a toast and emits no
    summarize call
  - _Requirements: 4.2, 4.3, 4.4, 4.5_

- [x] 3.4 experimental.session.compacting handler — augmentation
  - Register `'experimental.session.compacting'` named hook with
    `(input, output) => …` signature
  - Short-circuit if `selfCheckResult === "failed"`
  - If `augmentationEnabled === false` (R3.6): emit info-level
    `"augmentation skipped"` log and return without touching
    `output`
  - Otherwise: call `CavememContextSource.fetch(input.sessionID)`
  - On non-empty result: `output.context.push(result.text)` —
    NEVER set `output.prompt` (R3.5)
  - On empty / timeout / failure: do not modify `output`; opencode's
    native summary proceeds unaugmented (R3.3)
  - Emit `logAugmentation(sessionID, result.source,
    result.text.length)` (R6.2)
  - Observable: integration test 5.1 sees one entry pushed onto
    `output.context` after the handler returns; integration test
    5.3 (augmentation-disabled) sees `output.context` unchanged
    and zero cavemem subprocess invocations
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6, 6.2_

- [x] 3.5 session.idle handler — emit session summary log
  - Register `'session.idle'` named hook
  - On each event, look up `SessionState` for `input.sessionID`;
    emit `logSessionIdle(sessionID, { turnCount, totalInputTokens,
    wallTimeMillis, compactionEvents })` so the operator can audit
    per-session activity at idle (R6.5 "shutdown" clause)
  - Do NOT remove the session's state from `SessionTokenTracker` —
    the session may resume; cleanup is left to opencode's own
    session lifecycle (design §State Management)
  - Short-circuit if `selfCheckResult === "failed"` or the session
    is in the ignore-set from 3.1
  - Observable: at session idle, `app.log` carries one entry
    `service: "session-compaction", message: "session idle", extra: {
    sessionID, turnCount, totalInputTokens, wallTimeMillis }`
  - _Requirements: 6.5_

- [x] 3.6 session.compacted handler — trigger attribution + cooldown reset
  - Register `'session.compacted'` named hook
  - Look up `inFlightAttempts.get(input.sessionID)` (populated by
    `CompactionInvoker` in 2.4 / 3.2 / 3.3)
  - If matched: emit `logCompacted(sessionID, attempt.trigger)`
    where trigger is `"automatic"` or `"manual"`; delete the entry
    from `inFlightAttempts`
  - If unmatched: emit `logCompacted(sessionID, "external")` — this
    attributes opencode-native TUI `session.compact` keybind or any
    other non-plugin-initiated compaction (design critical-issue-2
    fix)
  - Call `SessionTokenTracker.resetStartedAt(sessionID, Date.now())`
    so the wall-clock threshold restarts from this point
  - Empirically confirm that `Session.time.compacting` persists
    post-compaction (design Logical Data Model open item); if not,
    fall back to recording `lastCompactionAt` in `SessionState` and
    document the deviation in a code comment + the steering doc
  - Observable: post-compaction, the next `message.updated` for
    this session treats it as freshly-started for wall-time
    purposes; the `app.log` carries one entry with
    `extra.trigger` set to one of `"automatic"`, `"manual"`,
    `"external"`
  - _Requirements: 6.1, 6.2_

- [ ] 4. Validation: unit tests (parallel — separate test files)

- [ ] 4.1 (P) ThresholdEvaluator unit tests
  - Create `tests/session-compaction/threshold-evaluator.test.ts`
    covering design §Testing Strategy / Unit Tests #1–#4: token
    threshold trip exactly at boundary; wall-time threshold trip;
    cooldown short-circuits trips; disabled threshold (null/0) is
    inert
  - Use `node --test` runner via the existing
    `opencode-cost-diagnosis-node` wrapper so NODE_PATH is set up
    for dev test deps
  - Observable: `opencode-cost-diagnosis-node --test
    tests/session-compaction/threshold-evaluator.test.ts` reports
    all assertions passing with non-zero test count
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.10_
  - _Boundary: tests/session-compaction/threshold-evaluator.test.ts_

- [ ] 4.2 (P) SessionTokenTracker unit tests
  - Create `tests/session-compaction/session-token-tracker.test.ts`
    covering design §Testing Strategy / Unit Tests #5: dedupe by
    messageID; aggregation across multiple messages; wall-time
    advances correctly after `resetStartedAt`
  - Observable: test file runs and reports pass under the dev
    wrapper
  - _Requirements: 2.1_
  - _Boundary: tests/session-compaction/session-token-tracker.test.ts_

- [ ] 4.3 (P) CavememContextSource unit tests
  - Create `tests/session-compaction/cavemem-context-source.test.ts`
    covering design §Testing Strategy / Unit Tests #6–#7: timeout
    produces empty result; never writes (verify via mocked spawn
    factory that the ONLY command invoked is `cavemem search` with
    read-only flags)
  - Observable: test file runs and reports pass under the dev
    wrapper
  - _Requirements: 3.3, 3.4_
  - _Boundary: tests/session-compaction/cavemem-context-source.test.ts_

- [ ] 4.4 (P) PluginSelfCheck unit tests
  - Create `tests/session-compaction/plugin-self-check.test.ts`
    covering design §Testing Strategy / Unit Tests #8: missing SDK
    method flips `disabled` flag; handlers short-circuit thereafter
  - Observable: test file runs and reports pass under the dev
    wrapper
  - _Requirements: 7.2, 7.4_
  - _Boundary: tests/session-compaction/plugin-self-check.test.ts_

- [ ] 5. Validation: integration tests (parallel — separate test files)

- [ ] 5.1 (P) Automatic-flow end-to-end integration test
  - Create `tests/session-compaction/integration/automatic-flow.test.ts`
  - Stub opencode runtime: a synthetic `message.updated` sequence
    drives threshold trip; assert `client.session.summarize` called
    exactly once with the expected sessionID
  - Stub the `experimental.session.compacting` invocation; assert
    the augmentation handler pushes the (stubbed) cavemem output
    into `output.context`; assert `output.prompt` is NOT set
  - Observable: integration test reports pass with the exact SDK
    call sequence and `output.context` mutation verified
  - _Requirements: 2.3, 3.1, 3.2_
  - _Boundary: tests/session-compaction/integration/automatic-flow.test.ts_

- [ ] 5.2 (P) Manual /compact integration test
  - Create `tests/session-compaction/integration/manual-flow.test.ts`
  - Stub `command.executed` with `name: "compact"`; assert
    `session.summarize` called and the augmentation handler fires
    identically to the automatic path
  - Add a zero-turn case: assert `tui.showToast` is invoked with
    `variant: "info"` and `session.summarize` is NOT called
  - Observable: integration test reports pass with augmentation
    parity between automatic and manual triggers
  - _Requirements: 4.2, 4.3, 4.4_
  - _Boundary: tests/session-compaction/integration/manual-flow.test.ts_

- [ ] 5.3 (P) Augmentation-disabled branch integration test
  - Create `tests/session-compaction/integration/augmentation-disabled.test.ts`
  - Configure plugin with `augmentationEnabled = false`; same
    trigger sequence as 5.1; assert compaction fires, cavemem
    subprocess is NOT spawned, `output.context` is unchanged
  - Observable: cavemem invocation counter (mocked spawn factory)
    is exactly 0 throughout the run; augmentation log shows
    "skipped" reason
  - _Requirements: 3.6_
  - _Boundary: tests/session-compaction/integration/augmentation-disabled.test.ts_

- [ ] 5.4 (P) Subagent gating + allowlist trichotomy integration test
  - Create `tests/session-compaction/integration/subagent-gating.test.ts`
    covering four scenarios in one suite:
    (a) `watchSubagents=false`: subagent session does NOT trigger
        compaction despite token threshold cross
    (b) `watchSubagents=true`, allowlist `match-any`: any subagent
        type triggers
    (c) `watchSubagents=true`, allowlist `match-listed = ["yb-sleuth"]`:
        `yb-sleuth` subagent triggers; `explore` subagent does not
    (d) `watchSubagents=true`, allowlist `match-none`: NO subagent
        triggers (sentinel `__MATCH_NONE__` honored by the plugin's
        env-var parser end-to-end)
  - Observable: each scenario's assertion passes; the trichotomy
    is verified end-to-end through Nix → env-var → plugin parser
  - _Requirements: 5.2, 5.3, 5.5_
  - _Boundary: tests/session-compaction/integration/subagent-gating.test.ts_

- [ ] 5.5 (P) External-trigger attribution integration test
  - Create `tests/session-compaction/integration/external-trigger.test.ts`
  - Stub a `session.compacted` event with no preceding
    plugin-initiated `CompactionAttempt` for that sessionID; assert
    the plugin's `app.log` emission carries `extra.trigger ===
    "external"`
  - Add a positive control: a plugin-initiated path that produces
    `extra.trigger === "automatic"` (proves the discriminator works
    both ways)
  - Observable: app.log mock receives both attribution variants
    correctly; the `inFlightAttempts` map is cleared after each
    matched event
  - _Requirements: 6.1, 6.2_
  - _Boundary: tests/session-compaction/integration/external-trigger.test.ts_

- [ ] 6. Validation: steering doc and manual replay procedure

- [ ] 6.1 Author steering document
  - Create `.kiro/steering/session-compaction.md` per design
    §Components / SteeringDoc / Implementation Notes content list:
    (1) when to invoke `/compact` manually; (2) what context
    augmentation preserves; (3) how to inspect a past compaction
    event including how to interpret the three `trigger`
    attribution values (`automatic`, `manual`, `external`); (4) how
    to retune `programs.session-compaction.thresholdTokens` and
    `thresholdWallTimeHours` based on `opencode-cost-report`
    output; (5) the validation methodology — copied verbatim or
    cross-referenced from design §Testing Strategy / Validation
    Tests Procedure 1 + Procedure 2
  - Document the resolved `client.app.log` persistence path
    captured by task 1.5 (R6.3)
  - Document the empirical finding about
    `Session.time.compacting` semantics captured by task 3.6,
    including the fallback path if persistence does not hold
  - Observable: file present at the documented path with all
    required sections; cross-reference to design.md's validation
    procedure is accurate and unambiguous
  - _Requirements: 4.6, 6.3, 9.2, 9.4_

- [ ] 6.2 Run Procedure 1 baseline-and-replay reduction test
  - Identify three workload sessions from the latest
    `opencode-cost-report` per design Procedure 1 selection
    criteria (`cost.total > $100`, wall-time > 24h, active
    project directory)
  - Capture pre-enablement bucket values per session:
    `accumulatedToolOutputsCached`, `accumulatedHistoryCached`,
    `cachedWrite`, `cost.total`
  - Run with default thresholds; re-run cost-report on the same
    sessions (or replay-produced sessions)
  - Apply Procedure 1 pass criteria: `accumulatedToolOutputsCached`
    reduced ≥40% on ≥2 of 3 sessions; `cachedWrite` did NOT rise
    more than +20% on any of the 3; ≥1 `app.log` compaction event
    with `trigger ∈ {automatic, manual}` per replay session that
    exceeded thresholds
  - On failure, record per-session deltas in the steering doc's
    tuning log; retune thresholds; repeat (max 2 iterations
    before escalation per Procedure 1 step 6)
  - Observable: a validation log records baseline + post values
    for each session and explicitly states PASS or FAIL against
    every criterion in Procedure 1
  - _Requirements: 9.1, 9.4_

- [ ] 6.3 Run Procedure 2 outlier-cap test
  - Drive a single opencode session past `thresholdTokens` (default
    500K) via tool-output-heavy turns OR replay an archived
    long-running session of the 30-day-outlier shape
  - Assert: ≥1 `session.compacted` event with
    `trigger ∈ {automatic, manual, external}` fires in `app.log`
    BEFORE the session's `cost.total` crosses $500 v1-equivalent
  - Observable: `app.log` records at least one compaction trigger
    before the cost threshold; no session reaches the 30-day-outlier
    cost profile (~$1,567 v1 cost) without compaction
  - _Requirements: 9.3_

- [ ] 7. Composition verification

- [ ] 7.1 Cost-diagnostic coexistence smoke
  - With session-compaction enabled and at least one compaction
    event having occurred on the host (validated by tasks 6.2 / 6.3),
    re-run `opencode-cost-report` on the host's live DB
  - Verify the diagnostic loads and produces all four canonical
    report sections (`Global Totals`, `Per-Project Breakdown`,
    `Per-Session Detail`, `Findings`) without errors attributable to
    the new `CompactionPart` rows
  - Verify any in-flight `subagent-context-budget` brief (if its
    spec.json has materialized by this point) coexists without
    install-time conflict — `programs.opencode.commands` attrset
    merge does not collide; both modules' assertions pass
  - Verify cavemem CLI and MCP surfaces are unchanged from
    pre-enablement state (no new tables, no new subcommands, same
    four MCP tools as documented in design §Allowed Dependencies)
  - Observable: post-enablement cost-report exits 0 with all four
    sections rendered; cavemem CLI `cavemem --help` shows the
    same subcommand set as design §Allowed Dependencies
  - _Requirements: 8.1, 8.2, 8.3_

## Implementation Notes

- **Task 1.5 (resolved)** — `client.app.log` writes land at
  `~/.local/share/opencode/log/` (singular `log/`, NOT `logs/` as
  the design speculatively assumed). The steering doc (task 6.1)
  must document this exact path under R6.3.
- **Task 1.2 (resolved)** — implementer sub-agents occasionally emit
  non-standard status report formats; a re-dispatch in the same
  session reliably produces the exact structured block.
- **Task 1.4 (resolved)** — `home.opencode.wrapperCommands` accepts
  list-merge across modules cleanly; no collision with the Shopify
  host's existing devx export snippet (verified post-1.4 flake check).
- **Task 2.1 (resolved)** — `recordMessage` early-returns for tokenless
  messages (UserMessages). `turnCount` is derived from
  `messageTokens.size` rather than tracked separately, matching
  R2.10's "LLM turns" semantic and avoiding the first-sight
  double-count bug on repeat UserMessage `message.updated` events.
- **Task 3.1 (resolved)** — R5.6's "benign degradation" path needed
  warn-level logging, not error-level. Added a `logWarn` wrapper
  alongside `logError`. R5.6's subagent-observability fallback emits
  warn; SDK failures (R7.5) still emit error via `logError`.
- **Task 3.4 (non-blocking nit deferred)** — augmentation-skipped paths
  (R3.6 augmentationEnabled=false; R3.3 empty cavemem result) currently
  reuse `logSuppression` (which emits `message: "compaction suppressed"`).
  Semantic intent is preserved via `extra.reason` (`augmentation_disabled` /
  `augmentation_empty`) but the message text is misleading because these
  paths don't suppress compaction — they skip augmentation while letting
  opencode's native summary proceed. Future polish: introduce a dedicated
  `logAugmentationSkipped` wrapper and migrate the two call sites.
