# Implementation Plan

- [ ] 1. Scaffold the script derivation and HM-module wrapper
- [x] 1.1 Create the empty script derivation skeleton
  - Create `scripts/memory-sync.nix` with the
    `{ pkgs, lib, opencodePackage }: pkgs.writeShellApplication { ... }`
    skeleton: `name = "memory-sync";`,
    `runtimeInputs = with pkgs; [ coreutils curl jq ];`, and a `text`
    body that for now contains only `usage()` (printing a placeholder
    string) and a `case "${1:-}" in --help|-h) usage; exit 0;; *)
    usage; exit 64;; esac` arm.
  - Bake the opencode binary path into a single `OPENCODE_BIN=
    ${lib.escapeShellArg "${opencodePackage}/bin/opencode"}` constant
    near the top of the script body so subsequent tasks can drop in
    the actual invocations.
  - Observable: `nix-build -E 'with import <nixpkgs> {};
    callPackage ./scripts/memory-sync.nix { opencodePackage = pkgs.hello; }'`
    succeeds (using `pkgs.hello` as a stand-in to keep the smoke
    independent of opencode availability); the resulting `bin/memory-sync
    --help` exits 0 and prints the placeholder usage.
  - _Requirements: 1.1, 1.3, 1.4_
  - _Boundary: OrchestratorScript_

- [x] 1.2 Create the home-manager module wrapper
  - Create `home-manager/common/memory-sync.nix` mirroring
    `home-manager/common/cc-sdd.nix` shape: `{ pkgs, lib, config, ... }`
    top-level args; `cfg = config.programs.memory-sync;`;
    `options.programs.memory-sync = { enable = lib.mkEnableOption "..."; }`;
    a `package` option declared as `lib.mkOption` with `readOnly = true`
    that exposes the built derivation for downstream consumers; and a
    `config = lib.mkIf cfg.enable { ... }` block.
  - Inside the `config` block, build the script derivation via
    `import ../../scripts/memory-sync.nix { inherit pkgs lib;
    opencodePackage = config.programs.opencode.package; }`, store it
    in a `let` binding so it's referenced once, expose it through both
    `programs.memory-sync.package` and `home.packages = [ ... ]`.
  - Add an `assertions = [ { assertion =
    config.programs.opencode.enable; message = "..."; } ]` block that
    fails HM evaluation if a host enables `programs.memory-sync`
    without also enabling `programs.opencode`.
  - Observable: a minimal HM `home.nix` that imports
    `memory-sync.nix`, sets `programs.opencode.enable = true` and
    `programs.memory-sync.enable = true`, builds successfully via
    `home-manager build`; the resulting profile contains
    `bin/memory-sync` on PATH; toggling
    `programs.memory-sync.enable = true` without
    `programs.opencode.enable = true` fails with the assertion
    message.
  - _Requirements: 1.2, 1.4, 11.5_
  - _Boundary: MemorySyncHmModule_
  - _Depends: 1.1_

- [x] 1.3 Wire the module into both host configurations
  - In `configurations/personal/...` (exact path determined by walking
    the existing import tree), add an `imports = [
    ../../home-manager/common/memory-sync.nix ];` entry alongside the
    existing common-module imports, and set
    `programs.memory-sync.enable = true;` in the same per-host
    profile.
  - Repeat for `configurations/shopify/...` with the equivalent
    addition.
  - Observable: `darwin-rebuild build --flake .#ShopifyLaptop` and
    `darwin-rebuild build --flake .#Brandons-MacBook-Pro` (or the
    flake's host names at implementation time) both succeed; the
    activation diff shows `bin/memory-sync` added to the user's
    profile.
  - _Requirements: 1.2, 11.5_
  - _Boundary: MemorySyncHmModule_
  - _Depends: 1.2_

- [ ] 2. Implement state, lock, and helper layer
- [x] 2.1 Define state-directory constants and `mkdir -p` bootstrap
  - At the top of the script body (after `OPENCODE_BIN` and before
    the flag parser), declare:
    `STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/memory-sync"`,
    `MARKER_FILE="$STATE_DIR/last-run"`,
    `LOCK_DIR="$STATE_DIR/lock"`,
    `LOG_DIR="$STATE_DIR/logs"`,
    `MCPHUB_BASE="http://localhost:37373"`.
  - Add a `bootstrap_state_dir()` helper that runs `mkdir -p
    "$STATE_DIR" "$LOG_DIR"` (the lock dir is intentionally NOT
    created here — it's created atomically by `acquire_lock`).
  - Wire `bootstrap_state_dir` into the early main-flow path so it
    runs on every non-`--help` invocation BEFORE
    `acquire_lock`, satisfying Requirement 4.AC6 (lock acquisition
    must not race against parent mkdir).
  - Observable: `MEMORY_SYNC_TEST=1 memory-sync` (when the script's
    main flow only contains the bootstrap step) creates the
    `$STATE_DIR` and `$LOG_DIR` directories without errors;
    re-running is idempotent (no errors from existing dirs).
  - _Requirements: 3.1, 3.2, 9.1, 9.2, 4.6_
  - _Boundary: OrchestratorScript_
  - _Depends: 1.1_

- [x] 2.2 Implement the mkdir-mutex lock with EXIT/INT/TERM trap
  - Add `acquire_lock()` and `release_lock()` helpers mirroring
    `scripts/sqlite-backup-cli.nix:219-236` shape: `acquire_lock`
    runs `mkdir "$LOCK_DIR" 2>/dev/null` and on success installs
    `trap 'rm -rf -- "$LOCK_DIR"' EXIT INT TERM`; on failure (mkdir
    returned EEXIST), prints an actionable error to stderr naming
    `$LOCK_DIR` and the recovery hint "If you are sure no other
    memory-sync run is in progress, remove the lock dir manually:
    rm -rf '$LOCK_DIR'", then exits 6.
  - `release_lock` runs `rm -rf -- "$LOCK_DIR"` and clears the trap
    (`trap - EXIT INT TERM`) so the cleanup runs at most once.
  - Wire `acquire_lock` into the early main-flow path immediately
    after `bootstrap_state_dir`.
  - Observable: a unit-style smoke test that runs `memory-sync &`
    twice in succession sees the second invocation exit 6 within
    one second and print the lock-held error; killing the first
    invocation with SIGINT removes the lock dir (verified via
    `ls "$LOCK_DIR" 2>&1 | grep "No such"`).
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 8.7_
  - _Boundary: OrchestratorScript_
  - _Depends: 2.1_

- [x] 2.3 Implement the marker read / write-atomic pair
  - Add `read_marker()` that prints the contents of `$MARKER_FILE`
    when it exists (one-line ISO 8601 UTC timestamp expected) and
    prints nothing (returns 0) when absent. Tolerates a trailing
    newline by stripping with `tr -d '[:space:]'`.
  - Add `write_marker_atomic()` that takes a single ISO 8601 UTC
    timestamp argument, writes it to `$MARKER_FILE.tmp` (in the
    same directory so the subsequent `mv` is a single rename(2)),
    runs `sync "$MARKER_FILE.tmp"` (or `cat` + redirect with no
    sync if `sync` is unavailable; coreutils ships `sync`), then
    `mv "$MARKER_FILE.tmp" "$MARKER_FILE"`. On any failure (write
    or rename), prints an actionable error naming the path and
    underlying errno on stderr and exits 3.
  - Add a `release_lock; exit 3` exit path for marker-write failures
    so the lock is released before exit (exit traps will also fire,
    but explicit release defends against the trap-removal-after-
    explicit-release ordering).
  - Observable: a unit-style smoke test that calls
    `write_marker_atomic "2026-05-14T10:00:00Z"` then
    `read_marker` prints `2026-05-14T10:00:00Z`; setting
    `chmod 0500 "$STATE_DIR"` then re-running causes the next
    `write_marker_atomic` invocation to exit 3 with the
    documented error.
  - _Requirements: 3.3, 3.5, 3.7, 3.9, 8.4_
  - _Boundary: OrchestratorScript_
  - _Depends: 2.1, 2.2_

- [x] 2.4 Implement the time-range computation helpers
  - Add `now_utc()` that prints `date -u +%Y-%m-%dT%H:%M:%SZ` once
    per invocation. Capture the result into a `NOW` variable in
    the main flow so the value is stable across the run (no risk
    of `date` rolling forward mid-run).
  - Add `parse_since(value)` that interprets the operator's
    `--since` argument and prints an ISO 8601 UTC timestamp:
    `YYYY-MM-DD` → midnight UTC; `YYYY-MM-DDTHH:MM:SSZ` → as-is;
    relative duration ("7 days ago", "3 hours ago") → result of
    `date -u -d "<value>" +%Y-%m-%dT%H:%M:%SZ`. On parse failure,
    print "memory-sync: error: cannot parse --since value
    '<value>'. Accepted shapes: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SSZ,
    or any relative duration parseable by date -d (e.g. '7 days
    ago')." to stderr and exit 64.
  - Add `compute_range()` that consults the operator-supplied
    `--since` value (if any) and the marker file (if present and
    no `--since`) and the 30-days-ago default (if neither);
    produces `RANGE_START` and `RANGE_END` variables in the
    enclosing scope. After computing both, asserts
    `RANGE_START < RANGE_END` (string comparison works for ISO
    8601); on violation, prints "memory-sync: error: computed
    range start (<start>) is at or after end (<end>)." to stderr
    and exits 64.
  - Observable: a smoke test that runs the script with `--since
    "2026-05-01"` and a marker present at `2026-05-10T00:00:00Z`
    captures `RANGE_START=2026-05-01T00:00:00Z` (i.e. `--since`
    wins over marker); same script with no `--since` and the same
    marker captures `RANGE_START=2026-05-10T00:00:00Z`; with no
    `--since` and no marker captures `RANGE_START=$(date -u -d "30
    days ago" +%Y-%m-%dT%H:%M:%SZ)`.
  - _Requirements: 3.4, 3.5, 3.6, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 8.8_
  - _Boundary: OrchestratorScript_
  - _Depends: 2.3_

- [x] 2.5 Implement the per-run logging surface
  - Add `open_log()` that captures `NOW` formatted with dashes
    instead of colons (`date -u -d "$NOW" +%Y-%m-%dT%H-%M-%SZ` or
    equivalent string substitution), sets `LOG_FILE=
    "$LOG_DIR/<formatted>.log"`, runs `umask 0077` BEFORE the
    first redirection, and exposes a `log_append()` helper that
    appends its argument to the log file. Skipped entirely when
    `--dry-run` is in effect.
  - Add `log_header()` that writes the documented header block
    (invocation timestamp, range, marker-before, flag values,
    opencode binary path) to the log via `log_append`.
  - Add `log_footer()` that writes the documented footer block
    (marker-after, exit code, synth summary) to the log via
    `log_append`. The synth-summary line is filled in from the
    parsed structured-return values when available; "(none)"
    otherwise.
  - Add `prune_logs()` that runs `ls -1t "$LOG_DIR" | tail -n
    +11 | xargs -I{} rm -f -- "$LOG_DIR/{}"` (safe when no files
    are over the limit because `tail -n +11` outputs nothing).
    Skipped entirely when `--dry-run` is in effect.
  - Add a `tee_to_log()` helper that takes a command and tee's
    its stdout+stderr through `tee -a "$LOG_FILE"` (and through
    `cat` to stdout when `--verbose` is also in effect, via
    `tee -a "$LOG_FILE" | tee /dev/tty` or equivalent).
  - Observable: a smoke test runs `memory-sync` with the main
    flow stubbed to call `open_log; log_header; log_append "test
    body"; log_footer; prune_logs` and verifies the resulting
    log file's mode is 0600 (`stat -f '%Lp' "$LOG_FILE"` returns
    `600` on darwin), the header/body/footer are present, and 11
    consecutive runs prune to 10 files in `$LOG_DIR/`.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10_
  - _Boundary: OrchestratorScript_
  - _Depends: 2.1, 2.4_

- [ ] 3. Implement pre-flight MCP probes and flag parsing
- [x] 3.1 Implement the mcphub HTTP probe helper
  - Add `probe_mcp_server(name, exit_code)` that issues a POST
    to `"$MCPHUB_BASE/api/servers/info"` with a JSON body of
    `{"server_name":"${name}"}` and `Content-Type: application/json`,
    capturing the response with `curl -sf --max-time 2`. The
    helper grep-asserts `"status":"connected"` is present in the
    response body. On failure (non-2xx, timeout, connect refused,
    OR `"status"` other than `"connected"`) the helper prints
    `memory-sync: ERROR: ${name} MCP unreachable. Recovery:
    launchctl kickstart gui/$(id -u)/com.ravitemer.mcp-hub` to
    stderr and exits with the supplied `exit_code`.
  - The naive `GET /api/servers/<name>` shape returns 404 in
    mcp-hub v4.2.1 (verified live during the
    `cavemem-integration` task 9.2 pass; see
    `memories/2026-05-14-mcp-hub-api-surface-and-wrapper-quoting.md`
    for the full route catalogue and why this POST endpoint is
    the documented per-server status surface).
  - Observable: with mcphub running and cavemem registered,
    `probe_mcp_server cavemem 4` returns 0 and prints nothing;
    with mcphub stopped via `launchctl bootout
    gui/$UID/com.ravitemer.mcp-hub`, the same call exits 4
    within ~2s and prints the documented kickstart hint.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 8.5, 8.6_
  - _Boundary: OrchestratorScript_
  - _Depends: 2.1_

- [x] 3.2 Wire the cavemem and obsidian probes into the main flow
  - In the main flow (after `acquire_lock`), call
    `probe_mcp_server cavemem 4` first, then
    `probe_mcp_server obsidian 5`. Cavemem-first ordering matches
    the brief's "fail fast with the appropriate exit code"
    constraint (cavemem is the more likely transient outage and
    short-circuits the obsidian probe when it fires).
  - Gate any probe-success printout behind `[ "$VERBOSE" =
    "true" ]`; in non-verbose mode the probes produce no output
    on success.
  - Observable: the main-flow smoke test from 3.1 also verifies
    that with cavemem unreachable but obsidian healthy, exit
    code is 4 (not 5) and only the cavemem error is printed; with
    cavemem healthy and obsidian unreachable, exit code is 5 and
    only the obsidian error is printed.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - _Boundary: OrchestratorScript_
  - _Depends: 3.1, 2.2_

- [x] 3.3 Implement the flag parser and `--help` arm
  - Replace the placeholder `--help` arm from 1.1 with a real
    flag parser. Walk `$@` with a `while [ $# -gt 0 ]; do case
    "$1" in ...; esac; done` loop. Recognized flags: `--since
    <value>` (require a value; `shift 2`), `--dry-run`
    (set `DRY_RUN=true`; `shift`), `--verbose|-v`
    (set `VERBOSE=true`; `shift`), `--no-curator` (set
    `NO_CURATOR=true`; `shift`), `--help|-h` (call `usage`;
    `exit 0`).
  - Default each flag variable to `false`/`""` before the loop
    so they're always defined.
  - On unknown flag: print "memory-sync: error: unknown flag
    '$1'. Run --help for usage." to stderr and exit 64.
  - Replace the placeholder `usage()` with the real one. The
    usage block names: every supported flag and a one-line
    semantic; every documented exit code (0–6) with a one-line
    description; the marker / lock / log paths; the accepted
    `--since` shapes; the `--dry-run` no-mutation guarantee.
  - Observable: `memory-sync --help` exits 0 and prints a usage
    block containing the substrings `--since`, `--dry-run`,
    `--verbose`, `--no-curator`, `--help`, `Exit code 0`,
    `Exit code 6`, `$XDG_STATE_HOME/memory-sync/`, `30 days ago`,
    `--dry-run does not write`. `memory-sync --bogus` exits 64
    and prints the unknown-flag error.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 8.8_
  - _Boundary: OrchestratorScript_
  - _Depends: 1.1_

- [ ] 4. Implement the synthesizer + curator orchestration
- [x] 4.1 Implement the synthesizer invocation and structured-return parser
  - In the main flow (after time-range computation and log open),
    construct the synthesizer prompt as the bare ISO 8601
    timestamp pair: `"$RANGE_START to $RANGE_END"` (no
    natural-language framing — see design Decision 10). This
    is the exact shape locked by `vault-synthesizer-agent`
    Requirement 10.AC7; the synthesizer's mission lives in
    its agent `.md` system prompt, so the user-message prompt
    only needs to carry the time-range argument.
  - Build the `opencode run` command: `"$OPENCODE_BIN" run
    --agent vault-synthesizer --format json
    --dangerously-skip-permissions --dir "$HOME" "<prompt>"`.
    Use `printf -v cmd '%q ' "${args[@]}"` discipline for
    safety, but the args are all script-controlled strings
    so simple quoting is acceptable.
  - When `--dry-run` is in effect, print "DRY RUN: would
    invoke: $OPENCODE_BIN run --agent vault-synthesizer ..."
    to stdout and SKIP the actual invocation.
  - Otherwise, invoke the command and pipe stdout through
    `tee -a "$LOG_FILE"` (and tee to stdout if `--verbose`),
    capturing the full event stream in a temporary file so it
    can be parsed after the run completes. Use
    `set -o pipefail` so the synthesizer's exit code propagates
    correctly past the `tee`.
  - On synthesizer non-zero exit: write `log_footer` with
    exit code 1 and `(none)` summary, print the synthesizer's
    stderr to the operator's stderr verbatim (already done by
    the `tee` to log if stdout/stderr are merged via `2>&1`),
    `release_lock`, exit 1. The marker is NOT updated.
  - On success, parse the captured event stream via `jq` to
    extract the synthesizer's final structured-return block.
    The jq filter selects events of the assistant-message
    type whose body contains the documented JSON object and
    extracts `time_range`, `observations_scanned`,
    `clusters_identified`, `clusters_promoted`,
    `clusters_skipped`, `drafts_written`, and `draft_paths`.
  - Store the parsed values in shell variables for use by the
    curator invocation (4.2) and the log footer (5.1).
  - Observable: a smoke test that stubs `OPENCODE_BIN` to a
    fixture script which prints a known JSON event stream and
    exits 0 verifies the parser extracts `drafts_written=2` and
    `draft_paths=["memories/2026-05-14-foo.md",
    "memories/2026-05-14-bar.md"]`. The same stub captures its
    invocation argv to a sentinel file and the smoke verifies
    the last positional argument (the prompt) matches the regex
    `^[0-9T:.Z-]+ to [0-9T:.Z-]+$` (i.e., bare timestamp pair,
    no natural-language framing — `vault-synthesizer-agent`
    Req 10.AC7). A second stub fixture that exits non-zero
    verifies the script exits 1, leaves the marker untouched,
    and skips the curator stage.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.9, 7.10, 7.11, 8.2_
  - _Boundary: OrchestratorScript_
  - _Depends: 2.4, 2.5, 3.3_

- [x] 4.2 Implement the curator invocation
  - When the synthesizer succeeds AND `--no-curator` is NOT in
    effect, construct the curator prompt as a single string
    naming the freshly drafted memory paths (so the curator
    can prioritize them): `"Run a targeted dedup pass over
    these new memory drafts: <comma-separated paths>"` (the
    paths come from the parsed `draft_paths` array). When
    `draft_paths` is empty (synthesizer skipped every cluster),
    the curator invocation is still made with a prompt
    explaining that no new drafts were produced and asking
    the curator to do a no-op confirmation; this keeps the
    log shape uniform.
  - Build the `opencode run` command:
    `"$OPENCODE_BIN" run --agent vault-curator --format json
    --dangerously-skip-permissions --dir "$HOME" "<prompt>"`.
  - When `--dry-run` is in effect, print "DRY RUN: would
    invoke: $OPENCODE_BIN run --agent vault-curator ..." to
    stdout and SKIP. When `--no-curator` is in effect, print
    "(curator skipped: --no-curator)" to the log and SKIP.
  - Otherwise, invoke the command with the same `tee`-to-log
    + `pipefail` discipline as 4.1.
  - On curator non-zero exit: write `log_footer` with exit
    code 2, print the curator's stderr verbatim, `release_lock`,
    exit 2. The marker is NOT updated.
  - On success, fall through to the marker-update step (4.3).
  - Observable: a smoke test with both stubs returning success
    runs both invocations and proceeds; a stub-curator failure
    fixture verifies exit 2, marker untouched. With
    `--no-curator`, the curator stub is not invoked at all
    (verifiable by the stub's "I was called" sentinel file
    not existing after the run).
  - _Requirements: 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.11, 8.3_
  - _Boundary: OrchestratorScript_
  - _Depends: 4.1_

- [x] 4.3 Implement the marker-update + log-prune success path
  - After the curator stage completes successfully (or was
    skipped via `--no-curator`), AND `--dry-run` is NOT in
    effect, AND `--since` was NOT supplied: call
    `write_marker_atomic "$NOW"` to update the marker.
  - When `--since` was supplied, skip the marker update
    (Requirement 3.AC6 + 7.AC8 + 10.AC5) but still complete
    the run successfully.
  - When `--dry-run` is in effect, print "DRY RUN: would
    update marker to $NOW" to stdout and SKIP both the
    marker write and the prune.
  - After the marker step, write `log_footer` with exit
    code 0 and the parsed synth summary, then call
    `prune_logs` (skipped on dry-run per Requirement
    9.AC8), then `release_lock`, then `exit 0`.
  - On success path, also print the operator-facing
    human-readable summary to stdout: range, draft count,
    curator skipped/run, marker advanced/unchanged, log
    path.
  - Observable: an end-to-end smoke run with both stubs
    succeeding leaves the marker file containing `$NOW`,
    leaves at most 10 log files in `$LOG_DIR`, releases the
    lock, and prints the operator summary. The `--since`
    variant succeeds with marker untouched. The
    `--dry-run` variant succeeds with marker untouched and
    no log file written.
  - _Requirements: 3.6, 3.7, 7.6, 7.8, 7.11, 8.1, 9.7, 9.8, 10.5_
  - _Boundary: OrchestratorScript_
  - _Depends: 4.2_

- [ ] 5. Wire end-to-end logging and operator summary refinement
- [x] 5.1 Backfill the log header / footer with parsed-return values
  - Update the `log_header()` call site so it runs AFTER
    `compute_range` and AFTER the `OPENCODE_BIN` is captured
    (so the header can record the resolved range and the
    absolute store path baked into this run).
  - Update `log_footer()` to consume the parsed
    structured-return values from 4.1 and write the one-line
    synth summary in the documented shape:
    `synth-summary: scanned=<N> clusters=<N> promoted=<N>
    skipped=<N> drafts=<N>`. When the parsed values are absent
    (synth failure path), write `synth-summary: (none)`.
  - Verify the header / footer shapes match the design
    document by spot-checking one successful run's log file
    against the design's "Per-run log file" section.
  - Observable: a successful end-to-end run produces a log
    file whose `head -10` contains the header block with all
    five required fields (timestamp, range, marker-before,
    flags, opencode path) and whose `tail -10` contains the
    footer block with `marker-after`, `exit-code: 0`, and
    `synth-summary: scanned=...`.
  - _Requirements: 9.3, 9.6_
  - _Boundary: OrchestratorScript_
  - _Depends: 4.3, 2.5_

- [x] 5.2 Polish operator-facing stderr error messages
  - Walk every `exit <N>` site and verify the preceding stderr
    print is actionable (names the failure class, the path or
    server, and the recovery hint where applicable).
  - Specifically verify: exit 1 surfaces synthesizer's stderr
    verbatim PLUS a "Re-run memory-sync to retry the same
    window (marker untouched)." trailer; exit 2 surfaces
    curator's stderr verbatim PLUS the same retry trailer;
    exit 3 names the path and the failed operation; exit 4 /
    5 name the MCP server and the kickstart hint; exit 6
    names the lock dir and the manual-removal hint; exit 64
    names the offending input.
  - Observable: triggering each failure class (via mcphub
    bootout for 4/5; second-instance for 6; chmod 0500 on
    state dir for 3; stub fixture exits non-zero for 1/2;
    `--bogus` for 64) produces output that a human operator
    can act on without reading the script source.
  - _Requirements: 4.3, 5.2, 5.4, 7.4, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_
  - _Boundary: OrchestratorScript_
  - _Depends: 4.3, 5.1_

- [ ] 6. Validate end-to-end and ship the operator memory note
- [x] 6.1 Run the manual smoke-test sequence on one host
  - On a host with cavemem + obsidian MCP both healthy and
    `programs.memory-sync.enable = true` activated, run the
    six-step manual smoke sequence from the design's "Manual
    Smoke Test" section: `--help`; `--dry-run`;
    `--no-curator --since "1 hour ago"`; no-args full run;
    second-instance lock check; mcphub-bootout cavemem-down
    check.
  - Verify each step produces the documented exit code and
    side-effects; record any deviations and fix the script
    before declaring this task done.
  - Observable: every step in the sequence behaves as
    documented in the design's "Manual Smoke Test" section.
    The verifier captures `echo $?` and the marker file's
    contents after each step, attaches them to the
    implementation note for review.
  - _Requirements: 1.5, 2.7, 3.6, 3.7, 4.3, 5.2, 7.6, 7.8, 7.11, 8.1, 8.7, 9.10, 11.4_
  - _Boundary: OrchestratorScript (integration check)_
  - _Depends: 5.2, 1.3_

- [ ] 6.2 Repeat the smoke-test sequence on the second host
  - Repeat 6.1 on the second nix-darwin host (the one not
    used in 6.1) to confirm host parity. The two hosts have
    different opencode wrappers (Shopify has Graphite addenda
    that personal lacks), so this catches any opencode-flag
    or wrapper interaction that's host-specific.
  - Observable: the same six-step sequence behaves
    identically on the second host. Any divergence is either
    fixed in the script or documented as a known per-host
    quirk in the troubleshooting memory.
  - _Requirements: 1.5, 11.5_
  - _Boundary: OrchestratorScript (integration check)_
  - _Depends: 6.1_

- [ ] 6.3 Author the Obsidian troubleshooting memory note
  - Via `hub_obsidian__write-note`, create
    `memories/<YYYY-MM-DD>-memory-sync-cli-overview.md`
    tagged `memory`, `nix-config`, `cavemem`,
    `memory-system`, `memory-sync`, `operations`.
  - The note explains: the orchestration model (cavemem →
    synthesizer → curator, marker advances on full success
    only); the marker / lock / log paths and what each
    does; the seven exit codes (0–6) with one-line
    explanations and recovery for each; a troubleshooting
    checklist for the common failure modes (cavemem down,
    obsidian down, synth crashed, curator crashed,
    marker-unwritable, lock held); references to
    `cavemem-integration` and `vault-synthesizer-agent`
    specs and the existing `vault-curator.md`.
  - Before creating the note, search the vault via
    `hub_obsidian__search-by-tags` for `memory-sync` and
    via `hub_obsidian__search-vault` for `memory-sync-cli`
    in `memories/` to confirm no overlapping note already
    exists; if one does, UPDATE it rather than creating a
    new one (per AGENTS.md memory dedup rule).
  - Observable: the note exists in the vault at the
    documented path; `hub_obsidian__read-note` returns
    content matching the documented sections; tag search
    for `memory-sync` returns the new (or updated) note.
  - _Requirements: 12.1, 12.2, 12.3_
  - _Boundary: TroubleshootingMemoryNote_
  - _Depends: 6.2_

## Implementation Notes

- 2026-05-14 (task 1.3): Task body says "wire into configurations/personal/...
  and configurations/shopify/..." but the actual repo structure uses
  `home-manager/common/default.nix` as the shared aggregator (both hosts
  inherit it via `../../../home-manager/common`). Wired memory-sync there
  alongside the existing cc-sdd precedent (`./cc-sdd.nix` import +
  `programs.cc-sdd.enable = true;`). Single-source wiring; both hosts get
  it automatically. Per-host wiring would have duplicated two lines. If
  a future task explicitly needs per-host enabling/disabling (e.g.,
  selective opt-out), use `programs.memory-sync.enable = lib.mkForce false;`
  in the per-host file rather than restructuring the wiring.
- 2026-05-16 (task 6.1, ShopifyLaptop): all 6 smoke steps PASS against live
  system. Step 1 (`--help`): exit 0, usage block present. Step 2
  (`--dry-run`): exit 0, no log written, marker unchanged, dry-run
  announcements emitted. Step 3 (`--no-curator --since "1 hour ago"`):
  exit 0, marker unchanged (--since one-shot), curator skipped, real synth
  ran with 0 drafts (selectivity at work for short window). Step 4
  (no-args full run): exit 0, marker advanced 2026-05-16T00:49:00Z →
  2026-05-16T01:06:38Z, curator ran, prune kept exactly 10 logs. Step 5
  (lock-held via pre-created lock dir): exit 6, stderr names lock path +
  manual-removal hint. Step 6 (mcphub bootout cavemem-down check): exit
  4, stderr names cavemem + kickstart hint; recovered via `launchctl
  bootstrap gui/$UID ~/Library/LaunchAgents/com.ravitemer.mcp-hub.plist`
  (note: bootout removes the service from launchd registry, so kickstart
  alone won't bring it back — must bootstrap the plist).
- 2026-05-15 (task 5.1): design.md §"Per-run log file" (~lines 1224-1241)
  uses header `=== memory-sync run <ts> ===` framing and footer labels
  `marker-before:` / `marker-after:` / `exit-code:` / `synth-summary:`. The
  current implementation uses `memory-sync run header` / `memory-sync run
  footer` plain-text framing and `marker: <val> (before)` / `marker: <val>
  (after)` / `exit code:` (space, not dash) labels — pre-existing drift
  from 2.5. Task 5.1 was explicitly scoped to the synth-summary label only;
  the other divergences were left as FYI follow-up. If a future task wants
  full design-doc alignment, the changes are confined to log_header and
  log_footer in scripts/memory-sync.nix — purely a label edit, no shell
  logic change.
- 2026-05-15 (task 4.3): genuine spec-internal conflict — Req 9.7 says "After
  a successful run AND after the marker update, memory-sync shall prune older
  log files"; design.md §OrchestratorScript Service Interface Postconditions
  says "On exit 0 with `--since` or `--dry-run`: marker untouched; logs
  untouched (dry-run) or written but not pruned (--since)"; task 4.3 body
  says only "call `prune_logs` (skipped on dry-run per Requirement 9.AC8)"
  without mentioning `--since`. Task 4.3 followed the task-body literal
  reading (always prune on success including `--since`); both reviewer and
  implementer flagged for follow-up spec amendment. User-visible effect is
  small: one extra `ls | tail | rm` per `--since` run; cannot lose data
  because prune respects the 10-file floor. If a future maintainer wants
  the design-doc behavior, add `[ -z "$SINCE" ]` guard inside `prune_logs`
  or before the prune call site at the end of the main flow.
- 2026-05-14 (task 2.5 → 3.3 cross-task action): The 2.5 logging helpers
  test `[ "${DRY_RUN:-0}" = "1" ]` (and same for VERBOSE/NO_CURATOR), but
  task 3.3's flag parser is specified to set `DRY_RUN=true` / `VERBOSE=true`
  / `NO_CURATOR=true`, and task 3.2 already uses `[ "$VERBOSE" = "true" ]`.
  At integration the 2.5 guards will all evaluate FALSE, violating Req
  9.AC8/9.AC9. **Action for the task-3.3 implementer:** when wiring up the
  flag parser, ALSO flip the four `= "1"` checks in scripts/memory-sync.nix
  (open_log, log_append, prune_logs, tee_to_log) to `= "true"` and update
  the four docstring lines that say "1 if --dry-run, else 0" / "1 if
  --verbose, else 0" / "1 if --no-curator, else 0" to "true if X, else
  empty/false". Per task 3.3 the parser must default each flag variable
  to `false`/`""` before the loop, so a bare `[ "$DRY_RUN" = "true" ]`
  is correct without `:-` defaults. This is the same family as the
  vault-synthesizer-agent task 1.10 fabricated-field-name lesson: cite
  contract verbatim across sections.
