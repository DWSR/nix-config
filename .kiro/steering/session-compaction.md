# Session compaction operator guide

`programs.session-compaction` installs an OpenCode plugin that triggers native
summarization after a session crosses a token or wall-clock threshold. The
plugin also provides `/compact` for manual compaction. AgentMemory captures
session activity independently; the compaction plugin does not add external
context to OpenCode's summary.

## Automatic and manual triggers

The plugin checks each `message.updated` event. It sums the distinct assistant
messages' `input + cache.read` tokens; updates to the same message replace the
previous snapshot. A session with zero LLM turns never compacts automatically.
The default thresholds are 500,000 tokens or 24 hours since session start (or
the last compaction). A 30-minute cooldown prevents repeated automatic
compactions. Disable either threshold by setting its option to `null`.

Use `/compact` before a large phase or when the automatic cooldown or a high
threshold delays compaction. It bypasses the automatic cooldown but refuses a
session with zero LLM turns and shows “Nothing to compact.” Both paths call
OpenCode's native `client.session.summarize`; the plugin observes
`session.compacted` to reset the wall-clock anchor and record the trigger.

## Inspect a compaction

OpenCode writes plugin `client.app.log` entries under
`~/.local/share/opencode/log/` (singular `log`). Filter for
`service=session-compaction` and inspect the structured `extra` fields:

| Message | Relevant fields | Meaning |
|---------|-----------------|---------|
| `self-check passed` / `self-check failed` | `extra.missing` on failure | Startup check of the required SDK methods; failure disables the plugin for this process. |
| `session started` | Thresholds, cooldown, subagent policy | Configuration in effect at session creation. |
| `compaction triggered` | `trigger`, `reason`, `timestamp` | The plugin called the native summarizer. |
| `session compacted` | `trigger` | A completed compaction, attributed to `automatic`, `manual`, or `external`. |
| `compaction suppressed` | `reason` | Threshold/cooldown/zero-turn guard prevented an attempt. |
| `session idle` | `turnCount`, `totalInputTokens`, `wallTimeMillis` | Current session totals. |
| `session-compaction error` | `errorMessage`, `context` | A compaction or handler failed. |

`external` means OpenCode compacted without a plugin-initiated attempt, such as
through its TUI keybind. Suppression reasons include `in_cooldown:<N>s_remaining`,
`zero_turns`, `zero_turns_manual`, `tokens_disabled`, `wall_time_disabled`,
and `no_threshold_met`. The latter is emitted on each below-threshold update;
exclude it when looking for actionable suppressions.

## Home Manager options

All options are under `programs.session-compaction`:

| Option | Default | Purpose |
|--------|---------|---------|
| `enable` | `false` | Install the plugin and `/compact` command. Both hosts enable it in the common module. |
| `thresholdTokens` | `500000` | Cumulative `input + cache.read` token threshold. |
| `thresholdWallTimeHours` | `24` | Hours since session start or most recent compaction. |
| `cooldownMinutes` | `30` | Minimum gap between automatic compactions. |
| `watchSubagents` | `false` | Apply automatic threshold logic to subagent sessions. |
| `subagentAllowlist` | `null` | With `watchSubagents=true`, `null` matches any, `[]` matches none, and a list matches named agents. |

For threshold tuning, compare `accumulatedToolOutputsCached`,
`accumulatedHistoryCached`, `cachedWrite`, and `cost.total` in
`opencode-cost-report` before and after representative sessions. A high
`manual`/`automatic` ratio suggests lowering the automatic thresholds; high
`cachedWrite` after frequent compactions suggests increasing the token
threshold or cooldown. Record each retune iteration and refer to
`.kiro/specs/session-compaction/design.md` §Testing Strategy for the original
replay and outlier-cap procedures.

## Cooldown persistence

The plugin reads `Session.time.compacting` from OpenCode for the cooldown and
resets its own wall-clock anchor when it sees `session.compacted`. If two
automatic compactions occur within `cooldownMinutes` for the same session,
check whether OpenCode retains `Session.time.compacting` after the first
compaction. See the persistence open item in
`home-manager/common/session-compaction-internal/session-compaction-impl.ts`.
