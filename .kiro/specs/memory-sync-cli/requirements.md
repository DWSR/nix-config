# Requirements Document

## Introduction

Ship `memory-sync` — a single shell command on PATH on both nix-darwin
hosts (Shopify and personal) that orchestrates the cavemem → vault
promotion pipeline end-to-end. The command invokes the
`vault-synthesizer` opencode subagent over a `[marker, now]` time
range, then chains the resulting drafts through the existing
`vault-curator` subagent for dedup, then atomically updates a marker
file so the next invocation picks up exactly where this one left off.

Without this command, exercising the pipeline requires the operator to
open opencode, type `@vault-synthesizer <range>`, wait, type
`@vault-curator`, wait, then manually note the timestamp somewhere and
remember to pass `--since <ts>` next time. That's the bookkeeping
cavemem was supposed to eliminate.

The command is packaged as `scripts/memory-sync.nix`
(`pkgs.writeShellApplication`) registered through the existing overlay,
mirroring the shape of `cc-sdd-init`, `mcp-verify-secrets`, and
`mcp-sync-from-1password`. State lives under
`$XDG_STATE_HOME/memory-sync/` (marker, lock, per-run logs). The
command runs from any directory, depends on no `.kiro/` files, and
makes no new MCP tool calls of its own — every interaction with
cavemem and Obsidian happens through the subagents it invokes.

This is the final spec in the cavemem integration roadmap. There are
no downstream consumers beyond a possible future
`memory-sync-schedule` spec that bolts a launchd timer on top.

## Boundary Context

- **In scope**: A single `memory-sync` shell binary built via
  `scripts/memory-sync.nix` and exposed through the existing
  `overlays/scripts.nix` overlay; the marker file at
  `$XDG_STATE_HOME/memory-sync/last-run`; the lock file at
  `$XDG_STATE_HOME/memory-sync/lock`; per-run log files under
  `$XDG_STATE_HOME/memory-sync/logs/<timestamp>.log` with last-10
  retention; pre-flight health checks for cavemem MCP and Obsidian
  MCP via the local mcphub HTTP API; the documented flag set
  (`--since`, `--dry-run`, `--verbose`/`-v`, `--no-curator`,
  `--help`/`-h`); the documented exit code conventions (0 success;
  1 synthesizer failed; 2 curator failed; 3 marker unwritable;
  4 cavemem MCP unreachable; 5 Obsidian MCP unreachable; 6 lock
  held); atomic marker update (write-tmp + fsync + mv); default
  time range (30 days ago) when the marker is missing AND no
  `--since` argument is supplied; idempotent re-runs (failed runs
  leave the marker untouched so retries cover the same window);
  the chosen subagent invocation mechanism (resolved in design as
  `opencode run --agent X --prompt Y --format json`); mechanical
  parsing of the synthesizer's structured return so the curator
  invocation gets the draft paths.
- **Out of scope**: Defining the `vault-synthesizer` subagent's
  behavior or rubric (owned by `vault-synthesizer-agent`); defining
  the `vault-curator` subagent's behavior (existing, unchanged);
  building or modifying cavemem itself (owned by
  `cavemem-integration`); any auto-scheduling of `memory-sync`
  (no launchd `StartInterval`, no `StartCalendarInterval`, no
  systemd timer — operator invokes manually; future work in a
  separate spec); cross-host marker coordination (each host has
  its own marker; cavemem is local SQLite per
  `cavemem-integration` Out scope); per-project sync variants (one
  global marker; per-project sync is a follow-up if/when needed);
  notification or desktop-alert UI on completion (logs are the
  output channel); writing to or reading from any `.kiro/` files
  (the command is independent of cc-sdd workflow); adding new MCP
  tools to cavemem or Obsidian; changes to the opencode wrapper
  health check (already shipped by `cavemem-integration`);
  modifying `home-manager/common/agents/vault-curator.md` or
  `vault-synthesizer.md`; any new HM module beyond the overlay
  registration needed to put the binary on PATH.
- **Adjacent expectations**: Consumes the contracts locked by
  `cavemem-integration` Requirement 10 — (a) cavemem MCP
  registered under the literal mcphub server name `cavemem`, so
  the pre-flight health check probes the mcphub HTTP API's
  per-server status endpoint (verified during the
  `cavemem-integration` live-verification pass: `POST
  /api/servers/info` body `{"server_name":"cavemem"}` asserting
  `"status":"connected"` in the JSON response); (b) the cavemem
  HM module has run, so the cavemem database at
  `${home.cavemem.dataDir}/data.db` exists (filename is
  literally `data.db`, verified at cavemem v0.2.1 source per the
  `cavemem-integration` task 7.2 implementation note); (c) the
  opencode wrapper's cavemem health check has not refused to
  launch opencode (i.e. cavemem MCP is up). Consumes the contracts
  locked by `vault-synthesizer-agent` — (a) the agent loads as
  `vault-synthesizer` in opencode's agent registry; (b) the
  agent accepts a single positional time-range argument
  (relative or absolute or ISO-8601 duration); (c) the agent
  emits a structured final summary including `time_range`,
  `observations_scanned`, `clusters_identified`,
  `clusters_promoted`, `clusters_skipped`, `drafts_written`,
  and `draft_paths` (vault-relative). Consumes the existing
  `vault-curator` agent's invocation surface (the curator does
  not require explicit draft-path arguments — it audits the
  vault and dedups whatever's new; the command passes a hint
  containing the freshly drafted paths so the curator can
  prioritize them).

## Requirements

### Requirement 1: Shell Binary on PATH via Overlay

**Objective:** As a host operator, I want `memory-sync` available on
PATH on both Shopify and personal hosts via the existing scripts
overlay, so that I can run the command from any terminal without
imperative installation steps.

#### Acceptance Criteria

1. The repository shall add a `scripts/memory-sync.nix` derivation
   that produces a `memory-sync` binary via
   `pkgs.writeShellApplication`, mirroring the shape of
   `scripts/cc-sdd-init.nix`, `scripts/mcp-verify-secrets.nix`,
   and `scripts/mcp-sync-from-1password.nix` (single
   `writeShellApplication` block with `runtimeInputs` listed
   explicitly).
2. The repository shall register the new derivation through the
   existing scripts overlay so that `command -v memory-sync`
   resolves to the binary on every host whose home-manager profile
   already imports the overlay.
3. The `memory-sync` binary shall declare `runtimeInputs` covering
   every external tool it shells out to (at minimum: `coreutils`
   for `mkdir` / `mv` / `date`, `curl` for the mcphub probes, the
   wrapped opencode binary surfaced via the existing
   `programs.opencode` derivation, and `jq` for parsing the
   `--format json` event stream from `opencode run`).
4. While the operator's home-manager profile already exposes the
   `programs.opencode.package` wrapped derivation on PATH,
   `memory-sync` shall invoke `opencode` by absolute Nix-store path
   baked at derivation time rather than relying on PATH lookup, so
   the binary cannot accidentally pick up a foreign opencode
   present in the operator's shell rc.
5. The `memory-sync` binary shall be runnable from any directory
   without modification — it shall not read or write any file
   under the current working directory, and it shall not depend
   on the cwd being a git working tree, a Nix flake, or a
   `.kiro/`-bearing project root.

### Requirement 2: Help and Flag Surface

**Objective:** As a host operator, I want a discoverable
`--help`/`-h` listing every supported flag and its semantics, so that
I never have to read the source to know what `memory-sync` accepts.

#### Acceptance Criteria

1. When invoked with `--help` or `-h`, `memory-sync` shall print a
   usage block to stdout and exit 0.
2. The usage block shall name every supported flag: `--since
   <when>`, `--dry-run`, `--verbose` (with short alias `-v`),
   `--no-curator`, and `--help` (with short alias `-h`).
3. The usage block shall name every documented exit code (0
   through 6) with a one-line description per code matching the
   semantics in Requirement 8.
4. The usage block shall name the marker, lock, and log paths
   (`$XDG_STATE_HOME/memory-sync/{last-run,lock,logs/}`) so the
   operator can locate them without reading the source.
5. When invoked with an unrecognized flag, `memory-sync` shall
   print an actionable error to stderr naming the offending flag
   and pointing at `--help`, and shall exit non-zero with an exit
   code distinct from the documented run-failure exit codes
   (acceptable: exit 64 / EX_USAGE, or any non-zero code outside
   the [0,6] documented range).
6. While `--since` is supplied, the usage block shall document
   the accepted shapes for the argument: an absolute date
   (`YYYY-MM-DD`), an absolute ISO 8601 timestamp
   (`YYYY-MM-DDTHH:MM:SSZ`), and a relative duration string
   accepted by `date -d` on the host's coreutils (e.g.
   `"7 days ago"`, `"3 hours ago"`).
7. The usage block shall state explicitly that `--dry-run`
   does not write to the marker file, does not write to the
   Obsidian vault, and does not prune logs.

### Requirement 3: Marker File Lifecycle

**Objective:** As a host operator, I want a single marker file at a
predictable location that records the timestamp of the last
successful sync, so that subsequent runs cover exactly the
[marker, now] window with no gaps and no double-processing.

#### Acceptance Criteria

1. The marker file shall live at
   `$XDG_STATE_HOME/memory-sync/last-run` (defaulting
   `$XDG_STATE_HOME` to `$HOME/.local/state` when unset, per the
   XDG Base Directory Specification).
2. While the marker file's parent directory does not exist on
   first run, `memory-sync` shall create it (and any missing
   ancestors) with `mkdir -p` before attempting any write to the
   marker, lock, or logs.
3. The marker file shall contain a single ISO 8601 UTC
   timestamp on a single line (terminating newline acceptable),
   matching the format `YYYY-MM-DDTHH:MM:SSZ`.
4. While the marker file does not exist AND no `--since`
   argument was supplied, `memory-sync` shall use a default
   range start of 30 days ago from invocation time, computed
   in UTC.
5. While the marker file exists AND no `--since` argument was
   supplied, `memory-sync` shall read the marker's timestamp
   and use it as the range start.
6. While `--since` is supplied (regardless of whether the
   marker exists), `memory-sync` shall use the parsed
   `--since` value as the range start and SHALL NOT update
   the marker file at the end of the run (`--since` is a
   one-shot override).
7. While the run completes successfully (synthesizer +
   curator both succeeded, OR curator was skipped via
   `--no-curator` and synthesizer succeeded) AND `--since`
   was NOT supplied AND `--dry-run` was NOT supplied,
   `memory-sync` shall update the marker file atomically: it
   shall write the new timestamp (the invocation's `now`) to a
   sibling tempfile (e.g. `last-run.tmp`), call `sync` on the
   tempfile or otherwise ensure the bytes are durable on
   disk, and then `mv` the tempfile to `last-run` so the
   replacement is a single rename(2) syscall.
8. While the run fails (synthesizer or curator non-zero, or
   any pre-flight failed), `memory-sync` shall NOT touch the
   marker file — the marker shall reflect only the last
   FULLY successful run.
9. While the marker's parent directory cannot be created OR
   the tempfile cannot be written OR the rename fails for any
   reason, `memory-sync` shall print an actionable error to
   stderr naming the path and the underlying errno, and shall
   exit with code 3 (marker unwritable).

### Requirement 4: Lock File Prevents Concurrent Runs

**Objective:** As a host operator, I want a second `memory-sync`
invocation to refuse to run while a first invocation is still
working, so that two concurrent syncs cannot race on the marker
or double-process the same observation cluster.

#### Acceptance Criteria

1. The lock file shall live at
   `$XDG_STATE_HOME/memory-sync/lock`.
2. On every non-`--help` invocation, `memory-sync` shall
   attempt to acquire the lock atomically via the established
   mkdir-mutex pattern (i.e. `mkdir
   $XDG_STATE_HOME/memory-sync/lock`, treating the directory's
   creation as the lock acquisition signal — the same
   technique used by `scripts/sqlite-backup-cli.nix`'s
   `acquire_lock` helper).
3. While the lock is already held by another invocation
   (mkdir returns EEXIST), `memory-sync` shall print an
   actionable error to stderr naming the lock path and
   suggesting the operator wait for the other run to finish
   (or remove the lock manually if they are confident no other
   run is in progress), and shall exit with code 6 (lock
   held).
4. While `memory-sync` holds the lock, it shall install a
   `trap` for EXIT/INT/TERM that removes the lock directory,
   so an interrupted run does not leave a stale lock that
   blocks subsequent invocations.
5. The lock acquisition shall happen BEFORE the marker file
   is read AND BEFORE the pre-flight health checks run, so
   that an early-exit pre-flight failure still releases the
   lock and a second invocation can run immediately.
6. The lock acquisition SHALL NOT race against the marker
   directory creation — the parent directory shall be
   created with `mkdir -p` before the lock acquisition
   attempt, so the lock acquisition only fails when the lock
   itself is held, not when the parent directory is missing.

### Requirement 5: Pre-Flight Health Checks

**Objective:** As a host operator, I want `memory-sync` to fail
fast with a specific exit code when cavemem MCP or Obsidian MCP
is unreachable, so that I never wait through a full opencode
spawn just to discover the run was doomed before it started.

#### Acceptance Criteria

1. After lock acquisition AND before invoking any opencode
   subagent, `memory-sync` shall probe cavemem MCP
   availability by issuing a short-timeout (≤ 2 seconds)
   `curl` against the local mcphub HTTP API endpoint that
   reports cavemem-server readiness. The exact endpoint is
   the same one the opencode wrapper's cavemem health check
   uses (per `cavemem-integration` Requirement 5 / design),
   resolvable via the literal mcphub server name `cavemem`.
2. While the cavemem MCP probe fails (connect refused,
   timeout, non-2xx response, or the response body indicates
   the cavemem server is unhealthy), `memory-sync` shall
   print an actionable error to stderr naming cavemem
   explicitly and including a `launchctl kickstart` recovery
   hint matching the pattern used by the opencode wrapper's
   cavemem check, and shall exit with code 4 (cavemem MCP
   unreachable).
3. After the cavemem probe succeeds AND before invoking any
   opencode subagent, `memory-sync` shall probe Obsidian
   MCP availability via the same mcphub HTTP API endpoint
   pattern, resolvable via the literal mcphub server name
   `obsidian`.
4. While the Obsidian MCP probe fails, `memory-sync` shall
   print an actionable error to stderr naming Obsidian
   explicitly and including the corresponding `launchctl
   kickstart` recovery hint, and shall exit with code 5
   (Obsidian MCP unreachable).
5. While both probes succeed, `memory-sync` shall proceed to
   the synthesizer invocation without printing any health-check
   output unless `--verbose` was supplied.
6. The pre-flight checks shall NOT call into cavemem or
   Obsidian MCP tools themselves (no `cavemem search`, no
   `hub_obsidian__list-notes`); they shall be transport-
   level health probes only. This distinguishes "the MCP
   server is down" from "the MCP server is up but a
   particular tool returned an error" so the operator fixes
   the right thing.

### Requirement 6: Time-Range Computation

**Objective:** As a host operator, I want `memory-sync` to compute
the [start, end] window deterministically from the marker (or
`--since`) and the invocation time, so that the synthesizer
processes exactly the intended observations.

#### Acceptance Criteria

1. The end of the time range shall always be the invocation's
   `now`, captured once at the start of the run as an ISO
   8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`).
2. While `--since YYYY-MM-DD` is supplied, the start shall be
   midnight UTC of that date.
3. While `--since YYYY-MM-DDTHH:MM:SSZ` is supplied, the
   start shall be that exact ISO 8601 timestamp.
4. While `--since "7 days ago"` (or any relative-duration
   string parseable by GNU `date -d`) is supplied, the start
   shall be the result of `date -u -d "<value>"
   +%Y-%m-%dT%H:%M:%SZ` evaluated against the invocation
   time.
5. While `--since` is supplied AND its value cannot be
   parsed by `date -d`, `memory-sync` shall print an
   actionable error to stderr naming the offending value and
   the accepted shapes (per Requirement 2.AC6), and shall
   exit non-zero with the same flag-error exit code used by
   Requirement 2.AC5 (acceptable: 64 / any non-zero outside
   the documented [0,6] run-failure range).
6. While `--since` is NOT supplied AND the marker file
   exists, the start shall be the marker's timestamp parsed
   as a literal ISO 8601 UTC timestamp.
7. While `--since` is NOT supplied AND the marker file does
   NOT exist, the start shall be 30 days before the
   invocation time computed as `date -u -d "30 days ago"
   +%Y-%m-%dT%H:%M:%SZ` (per Requirement 3.AC4).
8. While the computed start is AT OR AFTER the computed end
   (e.g. operator passed `--since "1 hour from now"` or the
   marker is somehow in the future), `memory-sync` shall
   print an actionable error to stderr naming both
   timestamps and shall exit non-zero with the same
   flag-error exit code used in 6.AC5.

### Requirement 7: Subagent Invocation Surface

**Objective:** As a host operator, I want `memory-sync` to invoke
`vault-synthesizer` and `vault-curator` through the supported
`opencode run` non-interactive surface, so that the orchestrator
inherits opencode's agent loader, MCP wiring, permission posture,
and auth handling rather than re-implementing them.

#### Acceptance Criteria

1. `memory-sync` shall invoke the synthesizer by exec'ing
   `opencode run --agent vault-synthesizer --format json
   --dangerously-skip-permissions --dir <safe-cwd> <prompt>`
   where `<prompt>` is the bare ISO 8601 timestamp pair
   `"<start> to <end>"` — each side formatted as
   `YYYY-MM-DDTHH:MM:SSZ` per Requirement 6.AC1 — with no
   natural-language framing wrapped around it. This is the
   exact shape `vault-synthesizer-agent` Requirement 10.AC7
   names as the format `memory-sync-cli` emits when it
   composes the synthesizer prompt from its marker file;
   wrapping the timestamps in framing text would risk the
   synthesizer's strict argument parser refusing the run
   under Requirement 10.AC4.
2. `memory-sync` shall set `<safe-cwd>` to the operator's
   `$HOME` (or another directory guaranteed to exist on
   every host) so the opencode subagent run does not
   depend on the operator's pwd.
3. `memory-sync` shall consume the synthesizer invocation's
   stdout (the JSON event stream produced by `--format
   json`) and parse it to extract the synthesizer's final
   structured summary block: `time_range`,
   `observations_scanned`, `clusters_identified`,
   `clusters_promoted`, `clusters_skipped`,
   `drafts_written`, and `draft_paths`.
4. While the synthesizer invocation exits non-zero OR exits zero without a
   valid structured summary containing all fields from 7.AC3,
   `memory-sync` shall print the synthesizer's stderr to
   the operator's stderr verbatim, append the same content
   to the per-run log, and exit with code 1 (synthesizer
   failed) WITHOUT updating the marker, WITHOUT invoking
   the curator, AND WITHOUT pruning logs.
5. While the synthesizer invocation exits zero AND
   `--no-curator` was NOT supplied, `memory-sync` shall
   invoke the curator by exec'ing `opencode run --agent
   vault-curator --format json
   --dangerously-skip-permissions --dir <safe-cwd>
   <curator-prompt>` where `<curator-prompt>` names the
   draft paths the synthesizer produced (so the curator can
   prioritize the new drafts) and asks for a targeted dedup
   pass.
6. While the synthesizer invocation exits zero AND
   `--no-curator` WAS supplied, `memory-sync` shall skip the
   curator invocation entirely and treat the run as
   successful for marker-update purposes (per Requirement
   3.AC7).
7. While the curator invocation exits non-zero,
   `memory-sync` shall print the curator's stderr to the
   operator's stderr verbatim, append the same content to
   the per-run log, and exit with code 2 (curator failed)
   WITHOUT updating the marker.
8. While both subagent invocations exit zero (or the
   curator was skipped via `--no-curator`), `memory-sync`
   shall update the marker file per Requirement 3.AC7 and
   exit 0.
9. The `--dangerously-skip-permissions` flag MUST be passed
   on every `opencode run` invocation because both
   subagents have a `bash` allow-list that opencode would
   otherwise prompt for in interactive mode; without
   `--dangerously-skip-permissions` the run would hang
   waiting for an operator who is not present (because
   `memory-sync` is being run non-interactively).
10. `memory-sync` SHALL NOT pass `--continue` or
    `--session` to either invocation; the synthesizer and
    curator runs are independent opencode sessions, and
    the orchestrator passes the synthesizer's draft paths
    to the curator's prompt explicitly rather than relying
    on session state.
11. While `--dry-run` was supplied, `memory-sync` shall
    construct the same prompts and announce them to the
    operator (and to the log) but SHALL NOT invoke
    `opencode run` for either subagent. It shall NOT
    update the marker, NOT prune logs, and exit 0.

### Requirement 8: Exit Code Conventions

**Objective:** As a host operator (and as a future scheduler
that wraps `memory-sync`), I want every documented failure mode
to map to a stable exit code, so that I can react to specific
failure classes (transient MCP outage vs. configuration error
vs. agent failure) without parsing stderr.

#### Acceptance Criteria

1. Exit code 0 shall mean "success": both subagents ran (or
   the curator was skipped via `--no-curator` and the
   synthesizer succeeded), the marker was updated (or the
   update was skipped because `--since` or `--dry-run` was
   in effect), and any pruning of old logs was completed.
2. Exit code 1 shall mean "synthesizer failed": the
   pre-flight passed and the lock was acquired, but the
   `opencode run --agent vault-synthesizer` invocation
   exited non-zero or returned no valid structured summary.
   The marker is untouched.
3. Exit code 2 shall mean "curator failed": the synthesizer
   succeeded, but the `opencode run --agent vault-curator`
   invocation exited non-zero. The marker is untouched.
4. Exit code 3 shall mean "marker unwritable": the marker
   file's parent directory could not be created, OR the
   tempfile write failed, OR the rename(2) of tempfile to
   marker failed.
5. Exit code 4 shall mean "cavemem MCP unreachable": the
   pre-flight cavemem health probe failed (connect refused,
   timeout, non-2xx, or unhealthy response).
6. Exit code 5 shall mean "Obsidian MCP unreachable": the
   pre-flight cavemem probe succeeded but the Obsidian
   probe failed.
7. Exit code 6 shall mean "lock held": the
   `mkdir $XDG_STATE_HOME/memory-sync/lock` returned EEXIST,
   indicating another `memory-sync` invocation is already
   in progress.
8. Exit codes 64 (or any non-zero code outside the
   documented [0,6] range) shall mean "usage error": an
   unknown flag, an unparseable `--since` value, or any
   other operator-input-shape error. Distinguishing this
   class of exit from the run-failure exit codes ensures a
   future scheduler does not alert on operator typos.
9. The documented exit codes shall be the ONLY non-zero
   codes the script produces under expected operating
   conditions; uncaught shell errors (e.g. an unexpected
   `set -e` propagation) shall be considered bugs to fix
   rather than additional documented codes.

### Requirement 9: Per-Run Logging and Retention

**Objective:** As a host operator (and as a future schedule
audit), I want every `memory-sync` invocation to leave a
self-contained log under
`$XDG_STATE_HOME/memory-sync/logs/<timestamp>.log` capturing the
synthesizer's output, the curator's output, the marker before/
after, the resolved time range, and the exit status, so that I
can diagnose a failure or audit a successful run after the
fact.

#### Acceptance Criteria

1. Per-run log files shall live at
   `$XDG_STATE_HOME/memory-sync/logs/<timestamp>.log` where
   `<timestamp>` matches the invocation's `now` timestamp
   formatted as `YYYY-MM-DDTHH-MM-SSZ` (colons replaced
   with dashes for filesystem compatibility).
2. The log file's parent directory shall be created with
   `mkdir -p` before any write attempt.
3. Each log file shall begin with a header block
   recording: the invocation timestamp, the resolved
   start and end of the time range, the marker value
   before the run (or `<absent>` if the marker did not
   exist), the value of every supplied flag, and the
   absolute path of the opencode binary the script will
   invoke.
4. Each log file shall capture the synthesizer
   invocation's stdout and stderr verbatim (interleaved
   acceptable; `2>&1`-style merging is acceptable).
5. While the curator invocation runs (i.e. it was not
   skipped via `--no-curator` and the synthesizer
   succeeded), the log shall capture its stdout and
   stderr verbatim as well.
6. Each log file shall end with a footer block recording:
   the marker value after the run (or `<unchanged>` if
   the marker was not updated), the final exit code, and
   a one-line human-readable summary derived from the
   synthesizer's structured return (counts and number of
   drafts) when available.
7. After a successful run AND after the marker update,
   `memory-sync` shall prune older log files in
   `$XDG_STATE_HOME/memory-sync/logs/` so that at most
   the 10 most recent log files remain (sorted by
   filename — the timestamped names sort
   chronologically by construction). Older files are
   removed via `rm`.
8. While `--dry-run` was supplied, log pruning SHALL NOT
   run, the per-run log SHALL NOT be written, and the
   "would-do" output goes to stdout (and to stderr for
   warnings) only.
9. While `--verbose` (or `-v`) was supplied, the per-run
   log content shall additionally be tee'd to stdout in
   real time so the operator can watch the run live; the
   on-disk log file shall be identical regardless of
   whether `--verbose` was supplied.
10. Log files shall be written with default umask (i.e.
    operator-only readable on a standard nix-darwin user
    profile); no special permission tightening is
    required, but the log files MUST NOT be world-readable
    if the umask happens to permit that — the script
    shall set `umask 0077` before opening the log to
    guarantee mode 0600.

### Requirement 10: Idempotency and Recovery

**Objective:** As a host operator, I want failed runs to be
safely re-runnable, so that an MCP outage in the middle of a
sync does not leave the marker in a broken state and a
subsequent retry covers exactly the same window the failed
run was attempting.

#### Acceptance Criteria

1. Any run that exits with code 1, 2, 3, 4, 5, or 6 shall
   leave the marker file untouched (per Requirements 3.AC8
   and 7.AC4 / 7.AC7).
2. Any run that exits with code 1 or 2 (a subagent
   failure) shall release the lock (via the EXIT trap from
   Requirement 4.AC4) so that an immediate retry can run.
3. While the marker file exists with a stale timestamp
   (the previous successful run was N days ago), a
   subsequent invocation with no `--since` argument shall
   process the entire [marker, now] window in one run; it
   shall not artificially cap the window.
4. While a previous run failed AFTER the synthesizer drafted
   memories but BEFORE the curator ran (e.g. the curator
   crashed), the next invocation shall re-run the
   synthesizer over the same window — the synthesizer
   cannot know what the prior run drafted, but vault-curator
   in the subsequent run will deduplicate any
   double-promoted memories per its existing dedup
   threshold (vault-curator Requirement: ~70% content
   overlap → merge in place). This is acceptable because
   curator deduplication is by design idempotent.
5. While the operator passes `--since` to override the
   marker for one run, that run SHALL NOT update the
   marker on success (per Requirement 3.AC6) — successive
   `--since` runs are non-progressing and the next
   no-argument run still picks up from the persisted
   marker.

### Requirement 11: Compatibility with Existing Workflows

**Objective:** As a host operator, I want `memory-sync` to be
ergonomically independent of cc-sdd workflow, of `.kiro/`-
bearing projects, and of any per-project state, so that I can
run it from any shell at any time without context-switching.

#### Acceptance Criteria

1. `memory-sync` SHALL NOT read or write any file under
   `.kiro/` (transcription, summary, spec.json, etc.) and
   SHALL NOT depend on the cwd containing a `.kiro/`
   directory.
2. `memory-sync` SHALL NOT modify any file outside
   `$XDG_STATE_HOME/memory-sync/` (other than via the
   subagent invocations, whose vault writes are mediated
   by the Obsidian MCP and whose targets are decided by
   the agents themselves).
3. `memory-sync` SHALL NOT depend on the operator's git
   identity, on a git working tree being present, or on
   any environment variable beyond `HOME`,
   `XDG_STATE_HOME` (optional, defaulted), and any
   variables the spawned `opencode run` invocation
   inherits (which are whatever the operator's shell
   exports — the script does not unset or rewrite them).
4. `memory-sync` shall be runnable from a launchd
   `ProgramArguments` invocation in a future
   `memory-sync-schedule` spec without modification —
   i.e. the script shall NOT prompt for any input on
   stdin under any code path (including the
   already-locked failure path), shall NOT require a
   controlling tty, and shall NOT depend on shell
   profile sourcing.
5. `memory-sync` shall coexist with `cc-sdd-init` /
   `mcp-verify-secrets` / `mcp-sync-from-1password` /
   `sqlite-backup` / `bump-shopify-taps` on the same
   host without conflicts; in particular, its lock,
   marker, and log paths shall be entirely distinct
   from any of those tools' state paths (shared under
   `$XDG_STATE_HOME` only at the directory-name level).

### Requirement 12: Documentation Memory Note

**Objective:** As a future operator who encounters
`memory-sync`'s role in the cavemem → vault pipeline, I want
a single Obsidian memory note that explains the
orchestration model, the marker semantics, and the recovery
sequence when a run fails, so that I do not have to re-derive
the architecture from scratch.

#### Acceptance Criteria

1. The integration shall ship a memory note under
   `memories/` in the Obsidian vault that explains: (a)
   `memory-sync`'s role as the orchestration surface for
   the cavemem → synthesizer → curator pipeline; (b) the
   marker file's location, format, and update semantics;
   (c) the lock file's location and the recovery
   procedure when a stale lock blocks a retry; (d) the
   per-run log path and retention policy; (e) the
   documented exit codes and what each one means; (f) a
   troubleshooting checklist for the most common failure
   modes (cavemem MCP down, Obsidian MCP down,
   synthesizer crashed, curator crashed,
   marker-unwritable).
2. The memory note shall be tagged with `memory`,
   `nix-config`, `cavemem`, `memory-system`,
   `memory-sync`, and `operations`.
3. The memory note shall reference the upstream specs
   (`cavemem-integration`, `vault-synthesizer-agent`)
   and the existing `vault-curator.md` agent so a
   maintainer can navigate to the relevant boundary
   contracts.
