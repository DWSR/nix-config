{
  pkgs,
  lib,
  opencodePackage,
}:
# memory-sync: orchestrates the cavemem → vault-synthesizer → vault-curator
# pipeline.
#
# This file currently contains the script DERIVATION SKELETON only.
# Subsequent tasks (2.x, 3.x, 4.x) flesh out state management, MCP
# probes, and subagent orchestration. The skeleton exists so that
# task 1.2's HM module wrapper can build a real (if minimal)
# derivation and task 1.3 can wire it into both host configs.
pkgs.writeShellApplication {
  name = "memory-sync";
  runtimeInputs = with pkgs; [
    coreutils
    curl
    jq
  ];
  text = ''
    set -euo pipefail

    # Baked-in absolute path to the wrapped opencode binary (AC 1.4 —
    # never rely on PATH lookup; the operator's shell rc must not be
    # able to substitute a foreign opencode). The path is interpolated
    # at Nix-eval time so the resulting shell script contains a literal
    # /nix/store/... reference.
    OPENCODE_BIN=${lib.escapeShellArg "${opencodePackage}/bin/opencode"}
    export OPENCODE_BIN

    # State directory layout (Req 3.AC1, 9.AC1; design Decision 2).
    # Defaults $XDG_STATE_HOME to $HOME/.local/state per XDG Base
    # Directory Spec. All four constants are evaluated at runtime via
    # Bash parameter expansion, NOT at Nix-eval time — hence the ''$
    # escape on the leading dollar sign.
    STATE_DIR="''${XDG_STATE_HOME:-$HOME/.local/state}/memory-sync"
    MARKER_FILE="''${STATE_DIR}/last-run"
    LOCK_DIR="''${STATE_DIR}/lock"
    LOG_DIR="''${STATE_DIR}/logs"
    export STATE_DIR MARKER_FILE LOCK_DIR LOG_DIR

    # mcpproxy HTTP base; the cavemem and obsidian probes hit
    # /api/v1/servers/<name> on this URL with an X-API-Key header.
    # Hardcoded per design Decision 6 + the mcpproxy-migration spec
    # (Domain F). The api key is read at probe time via
    # `security find-generic-password -s mcpproxy -a mcpproxy-api-key`.
    MCPPROXY_BASE="http://127.0.0.1:8080"
    export MCPPROXY_BASE

    # Create the state directories on every non-help invocation, BEFORE
    # acquire_lock (Req 4.AC6 — lock acquisition must not race against
    # parent-dir mkdir). The lock dir is intentionally NOT created here;
    # it is created atomically by acquire_lock (task 2.2). Idempotent —
    # mkdir -p succeeds if the dirs already exist.
    bootstrap_state_dir() {
      mkdir -p "$STATE_DIR" "$LOG_DIR"
    }

    # acquire_lock: mkdir-mutex on $LOCK_DIR (Req 4.AC1, AC2; design
    # Decision 3 — mirrors scripts/sqlite-backup-cli.nix:219-228 but
    # adapted for a single, fixed lock path rather than per-DB dynamic).
    # Returns 0 on success and installs a trap that removes the lock on
    # EXIT/INT/TERM (AC4). On EEXIST (lock already held), prints an
    # actionable error to stderr (AC3) and exits with code 6 (AC3,
    # 8.AC7).
    #
    # Caller contract: bootstrap_state_dir() MUST run first (AC6) so
    # mkdir's only failure mode here is a lock that is genuinely held,
    # not a missing parent. Caller must invoke this BEFORE marker reads
    # and pre-flight checks (AC5) so an early-exit failure still
    # releases the lock via the EXIT trap.
    #
    # The trap captures $LOCK_DIR by NAME (single-quoted in the trap
    # body), defensively allowing future code to reassign $LOCK_DIR
    # without breaking cleanup.
    acquire_lock() {
      if mkdir "$LOCK_DIR" 2>/dev/null; then
        trap 'rm -rf -- "$LOCK_DIR"' EXIT INT TERM
        return 0
      fi
      # mkdir failed — assume EEXIST (lock held by another invocation).
      cat >&2 <<EOF
    memory-sync: lock held at $LOCK_DIR

    Another memory-sync invocation appears to be in progress. Wait for
    it to finish, or — if you are sure no other memory-sync run is in
    progress — remove the lock dir manually:

      rm -rf '$LOCK_DIR'
    EOF
      exit 6
    }

    # release_lock: remove the lock dir and clear the EXIT/INT/TERM trap
    # so cleanup runs at most once (the trap would otherwise fire again
    # on script exit and rm a no-longer-existent dir — harmless with
    # `rm -rf` but noisy if a future revision tightens the cleanup).
    # Currently unused; future tasks (2.5+) may invoke it explicitly
    # before a successful exit. The EXIT trap handles the common case.
    # shellcheck disable=SC2329  # consumed by future tasks (2.5+)
    release_lock() {
      rm -rf -- "$LOCK_DIR"
      trap - EXIT INT TERM
    }

    # read_marker: print the marker file's timestamp to stdout, or
    # nothing (return 0) if the file does not exist. Strips any
    # whitespace (including the trailing newline that
    # write_marker_atomic emits) so the caller gets a clean ISO 8601
    # string that `date -u -d` can parse without further massaging.
    # Per Req 3.AC3, the marker is a single ISO 8601 UTC timestamp
    # (terminating newline acceptable). Per Decision 4 the format is
    # `YYYY-MM-DDTHH:MM:SSZ`.
    #
    # Currently unused by the script's own main flow; consumed by
    # task 2.4 (time-range computation) and task 4.x (main flow).
    # shellcheck disable=SC2329  # consumed by tasks 2.4, 4.x
    read_marker() {
      if [ -f "$MARKER_FILE" ]; then
        tr -d '[:space:]' < "$MARKER_FILE"
      fi
    }

    # write_marker_atomic <iso8601-utc-timestamp>
    # Atomically replaces $MARKER_FILE with the supplied timestamp
    # via tempfile + sync + rename(2) (Req 3.AC7, 3.AC9; Decision 4).
    # The tempfile lives in the same directory as $MARKER_FILE so
    # `mv` is a single rename(2) syscall (atomic on POSIX
    # filesystems within a single fs).
    #
    # Order: write → sync → rename. On a crash between sync and
    # rename, the old marker survives — the rename's atomicity
    # guarantees no partial replacement is ever visible.
    #
    # On any failure (write or rename), prints an actionable error to
    # stderr naming the path and a writability hint, calls
    # release_lock to drop the lock before exit (defensive — the
    # EXIT trap would also fire), and exits 3 (Req 8.AC4 — marker
    # unwritable).
    #
    # Currently unused by the script's own main flow; consumed by
    # task 4.3 (marker-update success path).
    # shellcheck disable=SC2329  # consumed by task 4.3
    write_marker_atomic() {
      local timestamp="$1"
      local tmpfile="$MARKER_FILE.tmp"

      if ! printf '%s\n' "$timestamp" > "$tmpfile" 2>/dev/null; then
        printf 'memory-sync: failed to write marker tempfile: %s\n' "$tmpfile" >&2
        printf '  (parent dir %s is %s)\n' \
          "$(dirname "$tmpfile")" \
          "$(test -w "$(dirname "$tmpfile")" && echo writable || echo "not writable")" >&2
        release_lock
        exit 3
      fi

      # sync the tempfile to make the bytes durable BEFORE the
      # rename so a crash between rename and reboot doesn't leave a
      # 0-byte marker (Req 3.AC9 — bytes durable on disk). coreutils
      # ships `sync FILE`, which we have on PATH via runtimeInputs.
      # If sync fails for any reason (e.g. the file was deleted out
      # from under us), continue — the rename's atomicity is the
      # primary guarantee; sync is belt-and-suspenders.
      if ! sync "$tmpfile" 2>/dev/null; then
        :
      fi

      if ! mv "$tmpfile" "$MARKER_FILE" 2>/dev/null; then
        printf 'memory-sync: failed to rename marker tempfile to final path: %s -> %s\n' \
          "$tmpfile" "$MARKER_FILE" >&2
        rm -f "$tmpfile"
        release_lock
        exit 3
      fi
    }

    # now_utc: print the current UTC time in ISO 8601 format
    # (`YYYY-MM-DDTHH:MM:SSZ`). Per Req 6.AC1 the end-of-range timestamp
    # is captured ONCE per invocation; the main flow (task 4.x) calls
    # this exactly once and stashes the result in a `NOW` variable so
    # the value is stable across the run (no risk of `date` rolling
    # forward mid-run).
    #
    # Currently unused by the script's own main flow; consumed by
    # task 4.x.
    # shellcheck disable=SC2329  # consumed by task 4.x
    now_utc() {
      date -u +%Y-%m-%dT%H:%M:%SZ
    }

    # parse_since <value>: interpret the operator's --since argument and
    # print an ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SSZ`). Accepts:
    #   - YYYY-MM-DD               → midnight UTC (Req 6.AC2)
    #   - YYYY-MM-DDTHH:MM:SSZ     → as-is, validated (Req 6.AC3)
    #   - relative duration        → `date -u -d "<value>"` output
    #     (e.g. "7 days ago", "3 hours ago"); Req 6.AC4
    #
    # Relies on GNU date semantics (date -u -d "..."); coreutils on
    # PATH via runtimeInputs guarantees GNU date even on darwin hosts
    # where the system `date` is BSD.
    #
    # On parse failure prints an actionable error to stderr naming the
    # offending value and the accepted shapes, then exits 64
    # (Req 6.AC5, 8.AC8).
    #
    # Currently called only by compute_range (also defined here);
    # exposed as a top-level function so future tasks (4.x) can probe
    # it directly if needed.
    # shellcheck disable=SC2329  # consumed by compute_range / task 4.x
    parse_since() {
      local value="$1"

      # Shape (a): YYYY-MM-DDTHH:MM:SSZ → as-is. Validate by re-parsing
      # via date -u -d to ensure the bytes are a real timestamp (e.g.
      # `2026-02-30T00:00:00Z` matches the regex but is not a real date).
      if [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
        if date -u -d "$value" +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
          printf '%s' "$value"
          return 0
        fi
      fi

      # Shape (b): YYYY-MM-DD → midnight UTC. Anchor explicitly with
      # `T00:00:00Z` to avoid date's locale-dependent default-of-noon
      # interpretation; emit whatever date prints (which is exactly
      # `YYYY-MM-DDT00:00:00Z`).
      if [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
        if date -u -d "''${value}T00:00:00Z" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null; then
          return 0
        fi
      fi

      # Shape (c): relative duration ("7 days ago", "3 hours ago",
      # "yesterday", etc.). Try date -u -d directly; if it parses,
      # capture and emit the result.
      local result
      if result=$(date -u -d "$value" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null); then
        printf '%s' "$result"
        return 0
      fi

      # All shapes failed → exit 64 (Req 6.AC5, 8.AC8).
      printf "memory-sync: error: cannot parse --since value '%s'. Accepted shapes: YYYY-MM-DD, YYYY-MM-DDTHH:MM:SSZ, or any relative duration parseable by date -d (e.g. '7 days ago').\n" "$value" >&2
      exit 64
    }

    # compute_range: produces RANGE_START and RANGE_END variables in
    # the enclosing scope. Resolves --since (if set) → marker (if
    # present) → 30-days-ago default (per Req 6.AC2-AC7 + Decision 5).
    # After computing both, asserts RANGE_START < RANGE_END (string
    # comparison works for ISO 8601 — the format is designed to sort
    # lexicographically); on violation, prints an actionable error to
    # stderr naming both timestamps and exits 64 (Req 6.AC8, 8.AC8).
    #
    # Inputs (read from caller-set variables):
    #   SINCE  — operator-supplied --since value, or empty / unset
    #            if --since was not passed (task 3.3 populates this
    #            from the flag parser).
    #   NOW    — fixed UTC timestamp captured at start of run (task
    #            4.x sets this from now_utc once per invocation).
    #
    # Outputs (set in caller scope, intentionally not local):
    #   RANGE_START
    #   RANGE_END
    #
    # Currently unused by the script's own main flow; consumed by
    # task 4.x.
    # shellcheck disable=SC2329  # consumed by task 4.x
    compute_range() {
      RANGE_END="$NOW"

      if [ -n "''${SINCE:-}" ]; then
        # --since wins over marker (Req 6.AC2-AC5).
        RANGE_START=$(parse_since "$SINCE")
      else
        local marker
        marker=$(read_marker)
        if [ -n "$marker" ]; then
          # Marker present → use as the literal ISO 8601 start
          # (Req 6.AC6).
          RANGE_START="$marker"
        else
          # No --since and no marker → default to 30 days ago
          # (Req 6.AC7 / Decision 5).
          RANGE_START=$(date -u -d "30 days ago" +%Y-%m-%dT%H:%M:%SZ)
        fi
      fi

      # Validate RANGE_START < RANGE_END. ISO 8601 timestamps with the
      # `YYYY-MM-DDTHH:MM:SSZ` shape sort lexicographically by design,
      # so a plain `<` inside `[[ ]]` is sufficient and avoids parsing
      # the timestamps back into epoch seconds.
      if [[ ! "$RANGE_START" < "$RANGE_END" ]]; then
        printf 'memory-sync: error: computed range start (%s) is at or after end (%s).\n' \
          "$RANGE_START" "$RANGE_END" >&2
        exit 64
      fi
    }

    # open_log: derive the log file path from $NOW (timestamp captured at
    # start of run via now_utc()), apply 0077 umask BEFORE the first
    # write, and create the file. The filename uses dashes instead of
    # colons (Req 9.AC1) for filesystem compatibility.
    #
    # No-op when DRY_RUN=true (Req 9.AC8).
    #
    # Inputs (read from caller scope, populated by main flow):
    #   NOW      — invocation timestamp (UTC ISO 8601), set by now_utc()
    #   LOG_DIR  — set at script init (top of the script)
    #   DRY_RUN  — "true" if --dry-run was supplied, else empty
    #
    # Outputs (set in caller scope):
    #   LOG_FILE — absolute path to the open log file
    #
    # The umask is applied BEFORE the first redirection so the resulting
    # file is created with mode 0600 (Req 9.AC10 — log files contain
    # potentially sensitive operator data; not world-readable).
    #
    # The DRY_RUN sentinel is a literal `"true"` (matching the value the
    # task-3.3 flag parser sets) and is unconditionally defaulted to ""
    # by that parser BEFORE this helper is reachable, so a bare
    # `"$DRY_RUN"` is safe under `set -u` without `:-` defaulting.
    # Per the cross-task implementation note from task 3.3, this guard
    # was migrated from `[ "''${DRY_RUN:-0}" = "1" ]` to
    # `[ "$DRY_RUN" = "true" ]` so the integration semantics with the
    # 3.3 parser hold (Req 9.AC8/9.AC9).
    #
    # Currently unused by the script's own main flow; consumed by
    # tasks 4.x / 5.x.
    # shellcheck disable=SC2329  # consumed by tasks 4.x, 5.x
    open_log() {
      if [ "$DRY_RUN" = "true" ]; then
        return 0
      fi
      # Replace colons with dashes in $NOW for filesystem compatibility:
      # 2026-05-14T10:30:00Z → 2026-05-14T10-30-00Z (Req 9.AC1).
      local fname="''${NOW//:/-}"
      LOG_FILE="$LOG_DIR/''${fname}.log"
      # umask 0077 BEFORE the first redirection so the log file is
      # created with mode 0600 (Req 9.AC10).
      umask 0077
      # Touch the file with the umask applied so subsequent appends
      # inherit the right mode.
      : > "$LOG_FILE"
    }

    # log_append <text>: append text to $LOG_FILE (newline added). No-op
    # when DRY_RUN="true" OR LOG_FILE is unset (open_log was skipped).
    #
    # DRY_RUN is unconditionally defaulted to "" by the task-3.3 flag
    # parser before this helper is reachable, so the bare `"$DRY_RUN"`
    # is safe under `set -u`. LOG_FILE may legitimately be unset (when
    # open_log was skipped), so the `:-` default is preserved on it.
    #
    # Currently unused by the script's own main flow; consumed by
    # tasks 4.x / 5.x.
    # shellcheck disable=SC2329  # consumed by tasks 4.x, 5.x
    log_append() {
      if [ "$DRY_RUN" = "true" ] || [ -z "''${LOG_FILE:-}" ]; then
        return 0
      fi
      printf '%s\n' "$1" >> "$LOG_FILE"
    }

    # log_header: write the run-start header block (Req 9.AC3) —
    # invocation timestamp, resolved range, marker-before, flag values,
    # opencode binary path.
    #
    # Inputs (read from caller scope, populated by main flow before this
    # is called):
    #   NOW              — invocation timestamp (UTC ISO 8601)
    #   RANGE_START      — resolved range start
    #   RANGE_END        — resolved range end
    #   MARKER_BEFORE    — marker contents before the run, or "<absent>"
    #   SINCE            — --since value, or empty
    #   DRY_RUN          — "true" if --dry-run was supplied, else empty
    #   NO_CURATOR       — "true" if --no-curator was supplied, else empty
    #   VERBOSE          — "true" if --verbose/-v was supplied, else empty
    #   OPENCODE_BIN     — baked at derivation time
    #
    # The `--dry-run=...` / `--no-curator=...` / `--verbose=...` fields
    # in the rendered `flags:` line surface the literal flag-variable
    # values ("true" or empty); the `:-<unset>` default keeps the empty
    # case readable in the log without confusing it with a literal
    # "false" or "0" the script never sets.
    #
    # Currently unused by the script's own main flow; consumed by
    # tasks 4.x / 5.x.
    # shellcheck disable=SC2329  # consumed by tasks 4.x, 5.x
    log_header() {
      log_append "memory-sync run header"
      log_append "  invocation:  $NOW"
      log_append "  range:       $RANGE_START → $RANGE_END"
      log_append "  marker:      ''${MARKER_BEFORE:-<absent>} (before)"
      log_append "  flags:       --since=''${SINCE:-<unset>} --dry-run=''${DRY_RUN:-<unset>} --no-curator=''${NO_CURATOR:-<unset>} --verbose=''${VERBOSE:-<unset>}"
      log_append "  opencode:    $OPENCODE_BIN"
      log_append ""
    }

    # log_footer: write the run-end footer block (Req 9.AC6) —
    # marker-after, exit code, synth summary one-liner.
    #
    # Inputs (read from caller scope):
    #   EXIT_CODE        — final exit code about to be returned
    #   MARKER_AFTER     — marker contents after run, or "<unchanged>"
    #   SYNTH_SUMMARY    — one-line summary string from the parsed
    #                      structured return; "(none)" when not available
    #
    # Currently unused by the script's own main flow; consumed by
    # tasks 4.x / 5.x.
    # shellcheck disable=SC2329  # consumed by tasks 4.x, 5.x
    log_footer() {
      log_append ""
      log_append "memory-sync run footer"
      log_append "  marker:      ''${MARKER_AFTER:-<unchanged>} (after)"
      log_append "  exit code:   ''${EXIT_CODE:-?}"
      log_append "  synth-summary: ''${SYNTH_SUMMARY:-(none)}"
    }

    # prune_logs: keep only the 10 most recent log files in $LOG_DIR
    # (Req 9.AC7). Sorted by mtime via `ls -1t`; tail -n +11 outputs
    # the 11th-and-onward filenames, which xargs feeds to rm -f.
    # Safe when fewer than 11 files exist (tail produces no output).
    #
    # No-op when DRY_RUN="true" (Req 9.AC8).
    #
    # DRY_RUN is unconditionally defaulted to "" by the task-3.3 flag
    # parser before this helper is reachable, so the bare `"$DRY_RUN"`
    # is safe under `set -u`.
    #
    # The pipeline runs from inside $LOG_DIR via a subshell so xargs
    # operates on bare filenames; the final `|| true` guards against a
    # partial-pipeline failure (e.g. ls finds nothing on first run).
    #
    # Currently unused by the script's own main flow; consumed by
    # task 4.3.
    # shellcheck disable=SC2329  # consumed by task 4.3
    prune_logs() {
      if [ "$DRY_RUN" = "true" ]; then
        return 0
      fi
      # ls is preferred here over find because the prescribed shape
      # (timestamped filenames sorting chronologically; `ls -1t` for
      # mtime-ordered output) is the cleanest expression of the
      # last-10 retention rule. Filenames are script-controlled
      # ISO-8601-shaped strings (no spaces, no newlines), so SC2012's
      # non-alphanumeric concern does not apply.
      # shellcheck disable=SC2012
      ( cd "$LOG_DIR" && ls -1t 2>/dev/null | tail -n +11 | xargs -I{} rm -f -- "{}" ) || true
    }

    # print_operator_summary: emit the operator-facing success summary
    # to stdout (task 4.3 body). Five fields per the task body spec:
    # range, draft count, curator status, marker status, log path.
    # Output shape adapts to --dry-run, --since, and --no-curator. The
    # caller MUST have already set MARKER_AFTER (the 4.3 marker-update
    # branch above does this) before invoking this helper.
    #
    # Inputs (read from caller scope; all set by 4.x main flow):
    #   DRY_RUN, SINCE, NO_CURATOR  — flag toggles (parser defaults to "")
    #   NOW                         — invocation timestamp (UTC ISO 8601)
    #   RANGE_START, RANGE_END      — resolved by compute_range
    #   SYNTH_DRAFTS_WRITTEN        — count parsed by parse_synth_report;
    #                                 unset when parse failed or under
    #                                 --dry-run (parser not invoked)
    #   MARKER_AFTER                — set by 4.3's marker branch
    #   LOG_FILE                    — set by open_log on real path;
    #                                 unset under --dry-run
    #
    # The header line distinguishes the real-success and dry-run shapes
    # so an operator scanning stdout can tell at a glance whether any
    # mutations were applied. Stdout (not stderr) per the task body:
    # "print the operator-facing human-readable summary to stdout".
    #
    # Currently consumed only by 4.3's success branch.
    # shellcheck disable=SC2329  # consumed by task 4.3
    print_operator_summary() {
      local marker_line curator_line drafts_line log_line header

      if [ "$DRY_RUN" = "true" ]; then
        marker_line="would advance to $NOW"
      elif [ -n "$SINCE" ]; then
        marker_line="unchanged (--since was supplied)"
      else
        marker_line="advanced to $NOW"
      fi

      if [ "$NO_CURATOR" = "true" ]; then
        curator_line="skipped via --no-curator"
      elif [ "$DRY_RUN" = "true" ]; then
        curator_line="would have invoked"
      else
        curator_line="run"
      fi

      if [ "$DRY_RUN" = "true" ]; then
        drafts_line="would have synthesized (no invocation)"
      elif [ -n "''${SYNTH_DRAFTS_WRITTEN:-}" ]; then
        drafts_line="''${SYNTH_DRAFTS_WRITTEN} written"
      else
        drafts_line="synth completed (parse failed; see log)"
      fi

      if [ "$DRY_RUN" = "true" ]; then
        log_line="not written (--dry-run)"
      else
        log_line="''${LOG_FILE:-<unknown>}"
      fi

      if [ "$DRY_RUN" = "true" ]; then
        header="DRY RUN: success (no mutations applied)"
      else
        header="memory-sync: success"
      fi

      printf '%s\n' "$header"
      printf '  range:    %s → %s\n' "$RANGE_START" "$RANGE_END"
      printf '  drafts:   %s\n' "$drafts_line"
      printf '  curator:  %s\n' "$curator_line"
      printf '  marker:   %s\n' "$marker_line"
      printf '  log:      %s\n' "$log_line"
    }

    # tee_to_log <command...>: run a command and tee stdout+stderr
    # through $LOG_FILE (Req 9.AC4, 9.AC5). When VERBOSE="true", also
    # tee to /dev/tty so the operator sees progress in real time
    # (Req 9.AC9).
    #
    # The caller is responsible for not invoking this under
    # DRY_RUN="true" (the dry-run code path should announce the
    # would-be invocation via stdout instead and skip the real command
    # entirely; see Req 7.AC11).
    #
    # VERBOSE is unconditionally defaulted to "" by the task-3.3 flag
    # parser before this helper is reachable, so the bare `"$VERBOSE"`
    # is safe under `set -u`.
    #
    # Currently unused by the script's own main flow; consumed by
    # task 4.x.
    # shellcheck disable=SC2329  # consumed by task 4.x
    tee_to_log() {
      if [ "$VERBOSE" = "true" ]; then
        "$@" 2>&1 | tee -a "$LOG_FILE" | tee /dev/tty > /dev/null
      else
        "$@" 2>&1 | tee -a "$LOG_FILE" > /dev/null
      fi
    }

    # parse_synth_report: read $SYNTH_CAPTURE, extract the synthesizer's
    # final structured-return JSON object from the LAST fenced code block
    # in any assistant-message text within the captured event stream, and
    # populate shell variables in the caller scope:
    #   SYNTH_TIME_RANGE_START, SYNTH_TIME_RANGE_END,
    #   SYNTH_OBS_SCANNED, SYNTH_CLUSTERS_IDENT, SYNTH_CLUSTERS_PROM,
    #   SYNTH_CLUSTERS_SKIP, SYNTH_DRAFTS_WRITTEN,
    #   SYNTH_DRAFT_PATHS (newline-separated; empty if no drafts),
    #   SYNTH_SUMMARY (one-line summary string for the log footer).
    #
    # Per `home-manager/common/agents/vault-synthesizer.md` `## Report`,
    # the agent emits the structured return as a JSON object literal
    # inside a fenced markdown code block in its final assistant message.
    # opencode `--format json` emits one event per stdout line; the exact
    # event-shape keys (`.type`, `.role`, `.text`, `.content`, …) are not
    # pinned in this repo's docs, so the parser is intentionally tolerant:
    # it walks every string value in every event via `jq -r '..|strings?
    # // empty'`, scans for fenced code blocks via awk, and selects the
    # LAST fenced block whose body parses as a JSON object containing the
    # documented seven required fields.
    #
    # On parse failure (no event stream, no matching fenced block, or
    # missing required fields), sets SYNTH_SUMMARY="(parse failed)" and
    # leaves the count vars empty / unset. For task 4.1 a parse failure
    # is non-fatal — only the synthesizer's exit code drives the
    # success / fail branch; the parsed values feed task 4.2 (curator
    # prompt) and task 5.1 (log-footer summary line).
    #
    # Inputs (read from caller scope):
    #   SYNTH_CAPTURE — path to the per-run event-stream tempfile
    #
    # Currently consumed by the main flow's success branch (4.1);
    # the parsed shell vars are read by tasks 4.2, 5.1.
    # SC2329: helper called only from the main-flow branch below.
    # SC2034: SYNTH_DRAFT_PATHS / SYNTH_TIME_RANGE_START /
    # SYNTH_TIME_RANGE_END are produced here for downstream tasks
    # (4.2 builds the curator prompt from SYNTH_DRAFT_PATHS; 5.1 may
    # surface the resolved time range in the log footer) but are not
    # yet consumed within this file.
    # shellcheck disable=SC2329,SC2034
    parse_synth_report() {
      local report
      # Step 1: walk every string value in every JSON event line and
      # emit it as RAW text (newlines decoded, quotes stripped) on its
      # own line. `jq -Rr 'fromjson? | ..|strings? // empty'` is the
      # canonical shape:
      #   -R     read each stdin line as a raw string (so a malformed,
      #          non-JSON line cannot fail the whole filter)
      #   -r     emit string outputs without surrounding quotes and
      #          with internal `\n` decoded to real newlines (so awk
      #          below can match `^```` lines literally — without -r
      #          the strings stay JSON-encoded and `\n` remains the
      #          two-byte sequence backslash-n, which never matches an
      #          awk `^```` line anchor)
      #   fromjson?  parse the line as JSON; on failure emit nothing
      #   ..|strings? // empty  walk the entire JSON tree, emitting
      #          every string value regardless of where in the event
      #          shape it lives. Robust to opencode's internal event
      #          shape (`.text` vs `.content` vs `.message.parts[…]`
      #          etc.) — we don't need to know the exact key path.
      # Step 2: awk extracts every fenced ```...``` block body from the
      # accumulated raw text. The flag toggles on each ```` line;
      # the body between toggles is accumulated into `blob` and
      # printed on the closing fence.
      # Step 3: pipe each candidate block through `jq -c` selecting the
      # documented seven-field shape; keep only the LAST match (in
      # case an earlier message accidentally contained a fenced
      # JSON-shaped block; the synthesizer's Report is always last).
      report=$(jq -Rr 'fromjson? | ..|strings? // empty' "$SYNTH_CAPTURE" 2>/dev/null \
        | awk '/^```/{flag=!flag; if(!flag){print blob; blob=""}; next} flag{blob=blob $0 "\n"}' \
        | jq -c 'select(.drafts_written != null and .draft_paths != null and .observations_scanned != null and .clusters_identified != null and .clusters_promoted != null and .clusters_skipped != null and .time_range != null)' 2>/dev/null \
        | tail -1)

      if [ -z "$report" ]; then
        SYNTH_SUMMARY="(parse failed)"
        return 0
      fi

      SYNTH_OBS_SCANNED=$(printf '%s' "$report" | jq -r '.observations_scanned')
      SYNTH_CLUSTERS_IDENT=$(printf '%s' "$report" | jq -r '.clusters_identified')
      SYNTH_CLUSTERS_PROM=$(printf '%s' "$report" | jq -r '.clusters_promoted')
      SYNTH_CLUSTERS_SKIP=$(printf '%s' "$report" | jq -r '.clusters_skipped')
      SYNTH_DRAFTS_WRITTEN=$(printf '%s' "$report" | jq -r '.drafts_written')
      SYNTH_DRAFT_PATHS=$(printf '%s' "$report" | jq -r '.draft_paths[]?')
      SYNTH_TIME_RANGE_START=$(printf '%s' "$report" | jq -r '.time_range.start')
      SYNTH_TIME_RANGE_END=$(printf '%s' "$report" | jq -r '.time_range.end')
      SYNTH_SUMMARY="scanned=$SYNTH_OBS_SCANNED clusters=$SYNTH_CLUSTERS_IDENT promoted=$SYNTH_CLUSTERS_PROM skipped=$SYNTH_CLUSTERS_SKIP drafts=$SYNTH_DRAFTS_WRITTEN"
    }

    # probe_mcp_server <server-name> <exit-code-on-failure>
    # Pre-flight HTTP-transport health probe against mcpproxy
    # (Req 5.1, 5.2, 5.3, 5.4, 5.6, 9.1, 9.2, 9.3; Decision 6 — pre-flight
    # at the HTTP-transport layer, NOT at the MCP-tool layer). Reads the
    # mcpproxy api key from the macOS Keychain
    # (service=mcpproxy, account=mcpproxy-api-key) at helper entry, then
    # issues a short-timeout (≤ 2s) GET to
    # $MCPPROXY_BASE/api/v1/servers/<name> with an `X-API-Key` header.
    # The response body is asserted with a permissive regex that matches
    # both `"status":"connected"` and `"connected":true` shapes (mcpproxy
    # currently emits the latter but the regex tolerates either).
    #
    # On any failure (keychain lookup empty, curl non-2xx, connect
    # refused, timeout, OR a response whose connected/status field does
    # not match), prints an actionable two-line error to stderr naming
    # the server explicitly and the new mcpproxy launchctl-kickstart
    # recovery hint (Req 5.2, 5.4, 9.2, 9.3, 8.5, 8.6), and exits with
    # the supplied exit code. Per the task body, an empty api key is
    # treated as "mcpproxy not configured" — which manifests as the
    # server being unreachable — and surfaces the same exit code.
    #
    # The endpoint shape and assertion regex mirror the live mcpproxy
    # preflight probes in `home-manager/common/cavemem.nix` (cavemem
    # branch, ~L498-514) and `home-manager/common/opencode.nix`
    # (obsidian branch, ~L131-147). Keeping the three probes in lockstep
    # means failure-mode parity holds across the activation script, the
    # opencode wrapper preflight, and this memory-sync CLI.
    #
    # Caller contract:
    #   - $MCPPROXY_BASE must be set (top-of-script default is
    #     "http://127.0.0.1:8080").
    #   - Caller decides WHEN to invoke (after lock acquisition, before
    #     subagent spawn — Req 5.1).
    #   - Caller decides whether to suppress success output via --verbose
    #     gating; this helper is silent on success per Req 5.5.
    #
    # Wired into the post-lock pre-flight sequence below (cavemem first
    # with exit 4, then obsidian with exit 5) per Req 5.1, 5.3, 9.3.
    probe_mcp_server() {
      local name="$1"
      local exit_code="$2"

      # Read the mcpproxy api key from the macOS Keychain. Use the
      # absolute path `/usr/bin/security` to match the reference probes
      # in cavemem.nix / opencode.nix — `security` is not on the
      # writeShellApplication PATH so a bare invocation would fail under
      # `set -u` / `set -e` even though we silence stderr.
      local api_key
      api_key=$(/usr/bin/security find-generic-password -s mcpproxy -a mcpproxy-api-key -w 2>/dev/null) || api_key=""

      if [ -z "$api_key" ]; then
        echo "memory-sync: ERROR: ''${name} MCP unreachable: mcpproxy API key missing from macOS Keychain (service=mcpproxy, account=mcpproxy-api-key)." >&2
        echo "Recovery: launchctl kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy" >&2
        exit "$exit_code"
      fi

      local response
      response=$(curl -sf --max-time 2 \
        -H "X-API-Key: $api_key" \
        "$MCPPROXY_BASE/api/v1/servers/$name" 2>/dev/null) || response=""

      if ! printf "%s" "$response" | grep -qE "\"(status|connected)\"[[:space:]]*:[[:space:]]*(\"connected\"|true)"; then
        echo "memory-sync: ERROR: ''${name} MCP unreachable." >&2
        echo "Recovery: launchctl kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy" >&2
        exit "$exit_code"
      fi
    }

    # usage: print the operator-facing help block to stdout (Req 2.1).
    # Names every supported flag with a one-line semantic (Req 2.2),
    # every documented exit code 0–6 + the 64 usage band (Req 2.3,
    # 8.AC8), the marker / lock / log paths under
    # $XDG_STATE_HOME/memory-sync/ (Req 2.4), the accepted --since
    # shapes (Req 2.6), and the --dry-run no-mutation guarantee
    # (Req 2.7).
    #
    # Heredoc is single-quoted (`<<'USAGE'`) so the literal `$`
    # in `$XDG_STATE_HOME/memory-sync/` is preserved verbatim — the
    # operator sees the env-var name they should expand themselves,
    # not whatever HM happened to set it to in the shell rendering
    # this help.
    usage() {
      cat <<'USAGE'
    memory-sync: orchestrate the cavemem → synthesizer → curator pipeline.

    Usage:
      memory-sync [--since <when>] [--dry-run] [--verbose|-v]
                  [--no-curator] [--help|-h]

    Options:
      --since <when>   Override the marker for one run. Accepted shapes:
                         YYYY-MM-DD                  (midnight UTC)
                         YYYY-MM-DDTHH:MM:SSZ        (exact ISO 8601 UTC)
                         <relative duration>         (any string parseable
                                                      by GNU date -d, e.g.
                                                      '7 days ago',
                                                      '30 days ago',
                                                      '3 hours ago')
                       --since does NOT update the marker on success
                       (one-shot override).
      --dry-run        Compute and announce the synthesizer / curator
                       prompts but do not invoke opencode.
                       --dry-run does not write to the marker file, to
                       the Obsidian vault, or to the per-run log, and
                       does not prune logs.
      --verbose, -v    Tee per-run log content to stdout in real time
                       and print pre-flight liveness confirmation to
                       stderr. The on-disk log file is identical
                       regardless.
      --no-curator     Run only the synthesizer; skip the
                       vault-curator dedup pass. The marker is still
                       updated on success.
      --help, -h       Print this help block to stdout and exit 0.

    Exit codes:
      Exit code 0    Success: synthesizer (and curator unless
                     --no-curator) ran cleanly; marker updated unless
                     --since or --dry-run was in effect; old logs
                     pruned.
      Exit code 1    Synthesizer failed: opencode run --agent
                     vault-synthesizer exited non-zero. Marker
                     untouched, curator not invoked.
      Exit code 2    Curator failed: synthesizer succeeded but
                     opencode run --agent vault-curator exited
                     non-zero. Marker untouched.
      Exit code 3    Marker unwritable: parent dir uncreatable, or
                     tempfile write or rename(2) failed.
      Exit code 4    Cavemem MCP unreachable through mcpproxy:
                     pre-flight probe failed (mcpproxy api key
                     missing from Keychain, connect refused,
                     timeout, non-2xx, or the connected/status
                     field on /api/v1/servers/cavemem did not
                     report connected). Recovery hint: launchctl
                     kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy.
      Exit code 5    Obsidian MCP unreachable through mcpproxy:
                     cavemem probe passed but obsidian probe failed.
                     Same recovery hint.
      Exit code 6    Lock held: another memory-sync invocation is in
                     progress. Wait, or remove the lock dir manually
                     if you are sure no other run is running.
      Exit code 64   Usage error: unknown flag, --since requires a
                     value, --since value unparseable, or computed
                     range start is at or after end. Distinct from
                     exit codes 0–6 so a future scheduler can
                     distinguish operator typos from run failures.

    State paths (all under $XDG_STATE_HOME/memory-sync/, defaulting
    $XDG_STATE_HOME to $HOME/.local/state per XDG Base Directory):
      $XDG_STATE_HOME/memory-sync/last-run         marker file (single
                                                   ISO 8601 UTC line)
      $XDG_STATE_HOME/memory-sync/lock             lock directory
                                                   (mkdir-mutex)
      $XDG_STATE_HOME/memory-sync/logs/            per-run logs,
                                                   <ts>.log filenames,
                                                   last-10 retention
    USAGE
    }

    # --- main flow ---------------------------------------------------
    #
    # Flag parser (Req 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 8.8). Walks
    # $@ flag-by-flag in a while loop so flag order is irrelevant to
    # the operator. `--since` is the only flag that consumes a second
    # argv slot; everything else is a bare boolean toggle. Defaults
    # are set BEFORE the loop so the logging helpers (open_log,
    # log_append, prune_logs, tee_to_log) can use bare `"$VAR"` checks
    # under `set -u` without `:-` defaulting — this is the integration
    # contract recorded in tasks.md "Implementation Notes" 2026-05-14
    # (task 2.5 → 3.3 cross-task action): the 2.5 helpers were
    # originally written against `[ "''${DRY_RUN:-0}" = "1" ]` (which
    # would silently evaluate FALSE in integration); this parser sets
    # DRY_RUN=true / VERBOSE=true / NO_CURATOR=true, and the four
    # helper guards have been migrated to `[ "$DRY_RUN" = "true" ]`
    # / `[ "$VERBOSE" = "true" ]` to match. The empty-string default
    # ensures the bare check is safe under `set -u`.
    SINCE=""
    DRY_RUN=""
    VERBOSE=""
    NO_CURATOR=""

    while [ $# -gt 0 ]; do
      case "$1" in
        --since)
          # Req 2.6: --since requires a value. Missing-value error is
          # reported as a usage-band exit (Req 8.AC8) so a future
          # scheduler does not alert on operator typos.
          if [ $# -lt 2 ]; then
            echo "memory-sync: error: --since requires a value (e.g. --since '7 days ago')." >&2
            exit 64
          fi
          SINCE="$2"
          shift 2
          ;;
        --dry-run)
          DRY_RUN="true"
          shift
          ;;
        --verbose|-v)
          VERBOSE="true"
          shift
          ;;
        --no-curator)
          NO_CURATOR="true"
          shift
          ;;
        --help|-h)
          usage
          exit 0
          ;;
        *)
          # Unknown flag → exit 64 (Req 2.5, 8.AC8). Error message
          # format is mandated verbatim by the task body so the future
          # operator and scheduler can both string-match it.
          echo "memory-sync: error: unknown flag '$1'. Run --help for usage." >&2
          exit 64
          ;;
      esac
    done

    # Export the parsed flag variables so any subprocess that reads
    # them (e.g. tee_to_log invoking commands that fan out) sees the
    # same toggle the parser established. Cheap; these are short
    # strings and the subagent invocations themselves do not consume
    # them, but downstream tasks 4.x may grow callers that benefit.
    export SINCE DRY_RUN VERBOSE NO_CURATOR

    bootstrap_state_dir
    acquire_lock
    # Pre-flight MCP-transport probes (Req 5.1, 5.3; Decision 6).
    # Cavemem first because (a) Req 5.5 mandates exit 4 (not 5)
    # when only cavemem is down, and (b) cavemem is the more likely
    # transient outage and a failure here `exit`s inside
    # probe_mcp_server before the obsidian probe ever runs.
    # probe_mcp_server is silent on success per Req 5.5.
    probe_mcp_server cavemem 4
    probe_mcp_server obsidian 5
    # Verbose-mode liveness confirmation (Req 5.5 — only emit
    # health-check output under --verbose). The bare `"$VERBOSE"`
    # check is safe under `set -u` because the parser above
    # unconditionally defaulted VERBOSE to "" before the loop.
    # We keep the `:-` form here for diff-minimality with the prior
    # task 3.2 wiring; it is a forward-compatible superset of the
    # canonical bare form (matches both unset and "true").
    # Output goes to stderr so it joins probe_mcp_server's own
    # error stream and the upcoming tee_to_log pipeline without
    # contaminating stdout, which is reserved for the success
    # summary in task 4.x.
    if [ "''${VERBOSE:-}" = "true" ]; then
      printf 'memory-sync: cavemem and obsidian MCP servers reachable\n' >&2
    fi

    # --- Synthesizer invocation (task 4.1) -----------------------------
    #
    # Task 4.1 wires the synthesizer half of the pipeline:
    #   1. Capture NOW once (Req 6.AC1) — stable across the run.
    #   2. Resolve [RANGE_START, RANGE_END] via compute_range
    #      (consumes SINCE / marker / 30-day default).
    #   3. Open the per-run log; write the header.
    #   4. Build the synthesizer prompt as the bare ISO 8601 timestamp
    #      pair "<start> to <end>" (Decision 10 / vault-synthesizer-agent
    #      Req 10.AC7) — no natural-language framing.
    #   5. Build the opencode argv:
    #        run --agent vault-synthesizer --format json
    #        --dangerously-skip-permissions --dir "$HOME" "<prompt>"
    #      (Req 7.1, 7.2, 7.9, 7.10).
    #   6. --dry-run: announce and skip (Req 7.11) — fall through to
    #      the existing usage/exit-64 placeholder so 4.2 / 4.3 can
    #      slot in their own dry-run announcements.
    #   7. Otherwise: invoke the command, tee'ing combined stdout+stderr
    #      to $LOG_FILE (Req 9.AC4) and a per-run capture tempfile that
    #      the parser consumes; tee additionally to /dev/tty under
    #      --verbose (Req 9.AC9). pipefail so the synth's exit code
    #      survives the tee chain.
    #   8. Synth non-zero (Req 7.4, 8.AC2): write log_footer with exit
    #      code 1 and "(none)" summary, release_lock, exit 1. Marker
    #      untouched (Req 3.AC8 / Req 10.AC1). Curator NOT invoked
    #      (Req 7.AC4).
    #   9. Synth zero: parse the captured event stream via
    #      parse_synth_report; the parsed values feed task 4.2 (curator
    #      prompt) and task 5.1 (log-footer summary line). Fall through
    #      to the placeholder so 4.2 / 4.3 own their own logic.
    NOW=$(now_utc)
    MARKER_BEFORE=$(read_marker)
    [ -z "$MARKER_BEFORE" ] && MARKER_BEFORE="<absent>"
    compute_range
    open_log
    log_header

    # Decision 10 / vault-synthesizer-agent Req 10.AC7: bare ISO 8601
    # timestamp pair, no natural-language framing.
    SYNTH_PROMPT="$RANGE_START to $RANGE_END"

    # All argv elements are script-controlled strings (no operator-
    # supplied substitutions land here unsanitized). Bash array
    # expansion under "''${SYNTH_ARGS[@]}" preserves quoting.
    SYNTH_ARGS=(
      run
      --agent vault-synthesizer
      --format json
      --dangerously-skip-permissions
      --dir "$HOME"
      "$SYNTH_PROMPT"
    )

    if [ "$DRY_RUN" = "true" ]; then
      # Req 7.AC11: announce the would-invoke command on stdout and
      # SKIP the actual invocation. Use %q to quote each argv element
      # so the operator can copy-paste the command verbatim if they
      # want to run it by hand.
      printf 'DRY RUN: would invoke: %s' "$OPENCODE_BIN"
      for arg in "''${SYNTH_ARGS[@]}"; do
        printf ' %q' "$arg"
      done
      printf '\n'
      # Curator dry-run announcement (Req 7.5, 7.6, 7.11 / task 4.2).
      # When --no-curator is in effect, announce the skip (Req 7.6 +
      # 7.11 — the announcement still happens under dry-run so the
      # operator can see what would be elided). Otherwise, announce
      # the would-invoke curator command. The curator prompt body
      # cannot be enumerated under dry-run because the synth was not
      # invoked, so we surface a placeholder string in place of the
      # comma-separated draft paths.
      if [ "$NO_CURATOR" = "true" ]; then
        printf 'DRY RUN: curator skipped (--no-curator)\n'
      else
        printf 'DRY RUN: would invoke: %s' "$OPENCODE_BIN"
        printf ' %q' run --agent vault-curator --format json \
          --dangerously-skip-permissions --dir "$HOME" \
          '<curator prompt depends on synth output>'
        printf '\n'
      fi
      # Task 4.3 (marker dry-run line + exit 0) extends the dry-run
      # branch downstream. Falls through to the placeholder.
    else
      # Capture the event stream to a tempfile under $LOG_DIR for
      # post-run parsing (jq scoring + awk fence extraction). The
      # tempfile lives next to the per-run log so it is cleaned up
      # next to the operator's audit trail. ".tmp.$$" suffix avoids
      # collisions if two runs ever raced (the lock prevents that,
      # but defensive).
      SYNTH_CAPTURE="$LOG_DIR/.synth-stream.tmp.$$"

      # pipefail so the synth's exit code propagates past the tee
      # chain. Without it, the rightmost tee's exit code (always 0)
      # would mask a synth failure.
      #
      # The whole pipe is wrapped in `if … ; then synth_exit=0; else
      # synth_exit=''${PIPESTATUS[0]}; fi` because `set -e` (active at
      # the top of the script) would otherwise abort the script the
      # moment the pipe returned non-zero, before we can capture
      # PIPESTATUS and route to the synth-failed branch with the
      # documented exit code 1. Inside an `if` test, `set -e` is
      # explicitly suspended — POSIX behaviour, leveraged here as a
      # narrower-than-`set +e` guard.
      set -o pipefail
      if [ "$VERBOSE" = "true" ]; then
        # --verbose: tee combined stdout+stderr to log AND to capture
        # tempfile AND to /dev/tty so the operator sees the run live
        # (Req 9.AC9).
        if "$OPENCODE_BIN" "''${SYNTH_ARGS[@]}" 2>&1 \
            | tee -a "$LOG_FILE" \
            | tee "$SYNTH_CAPTURE" \
            | tee /dev/tty > /dev/null
        then
          synth_exit=0
        else
          synth_exit=''${PIPESTATUS[0]}
        fi
      else
        # Default: tee to log and capture only. The synth's stderr is
        # already in $LOG_FILE via the 2>&1 merge (Req 9.AC4).
        if "$OPENCODE_BIN" "''${SYNTH_ARGS[@]}" 2>&1 \
            | tee -a "$LOG_FILE" \
            | tee "$SYNTH_CAPTURE" > /dev/null
        then
          synth_exit=0
        else
          synth_exit=''${PIPESTATUS[0]}
        fi
      fi
      set +o pipefail

      if [ "$synth_exit" -ne 0 ]; then
        # Req 7.AC4 / 8.AC2: synth failed. Marker untouched. Curator
        # not invoked. Footer captures the failure for the audit log;
        # release_lock + exit 1 here (the EXIT trap would also fire).
        EXIT_CODE=1
        SYNTH_SUMMARY="(none)"
        MARKER_AFTER="<unchanged>"
        # Req 7.AC4: surface the synthesizer's stderr to the operator's
        # stderr verbatim. The synth's stdout+stderr were merged via
        # 2>&1 above and captured to $LOG_FILE, so the log already
        # holds the verbatim bytes (also satisfying the "append to
        # per-run log" half of 7.AC4). Replay the tail of the log to
        # the operator's stderr — bracketed with delimiter lines so a
        # human reading the terminal can distinguish the captured
        # output from the script's own summary trailer below — BEFORE
        # log_footer writes the footer block, so the tailed lines are
        # the synth's actual output rather than the script's footer.
        if [ -f "$LOG_FILE" ]; then
          printf -- '--- last 20 lines of %s (synthesizer output) ---\n' "$LOG_FILE" >&2
          tail -n 20 "$LOG_FILE" >&2
          printf -- '--- end of log tail ---\n' >&2
        fi
        log_footer
        rm -f "$SYNTH_CAPTURE"
        # Concise operator-facing trailer naming the failure class
        # and the recovery action (Req 7.AC4, 8.AC2). The
        # parenthetical "(marker untouched)" reassures the operator
        # that re-running covers the same window — no state to
        # reconcile by hand.
        printf 'memory-sync: synthesizer exited %d. Re-run memory-sync to retry the same window (marker untouched).\n' "$synth_exit" >&2
        release_lock
        exit 1
      fi

      # Synth succeeded. Parse the structured return so the parsed
      # shell vars are available to task 4.2 (curator prompt) and
      # task 5.1 (log-footer summary).
      parse_synth_report

      rm -f "$SYNTH_CAPTURE"

      # --- Curator invocation (task 4.2) ----------------------------
      #
      # Decision 7 / Req 7.5: the curator runs as an INDEPENDENT
      # opencode session AFTER the synthesizer succeeds. The
      # synthesizer's draft paths are surfaced in the curator's
      # prompt so the curator can prioritize the newly written
      # drafts (Req 7.5, 7.10) — no --continue/--session/--fork
      # coupling. Curator failure does NOT roll back the synth's
      # drafts (Decision 7) — those drafts are valid memory notes
      # by construction (vault-synthesizer Req 9), and a re-run of
      # memory-sync will re-process the same window because the
      # marker is left untouched on curator failure (Req 7.7).
      #
      # --no-curator (Req 7.6 / task 4.2): skip the curator
      # invocation entirely; log the skip and fall through to the
      # marker-update path (4.3 owns the success exit 0).
      if [ "$NO_CURATOR" = "true" ]; then
        log_append "(curator skipped: --no-curator)"
      else
        # Build the curator prompt. SYNTH_DRAFT_PATHS is newline-
        # separated (output of `jq -r '.draft_paths[]?'` in
        # parse_synth_report). Convert to comma-separated for the
        # prompt body via `tr | sed`. When the synth produced no
        # drafts (empty SYNTH_DRAFT_PATHS — e.g., every cluster
        # was skipped), the curator is STILL invoked but with a
        # no-op confirmation prompt — keeps the log shape uniform
        # across "had drafts" and "no drafts" runs (task 4.2 body).
        if [ -n "''${SYNTH_DRAFT_PATHS:-}" ]; then
          draft_paths_csv=$(printf '%s' "$SYNTH_DRAFT_PATHS" \
            | tr '\n' ',' | sed 's/,$//')
          CURATOR_PROMPT="Run a targeted dedup pass over these new memory drafts: $draft_paths_csv"
        else
          CURATOR_PROMPT="No new memory drafts were produced in this sync window. No targeted dedup needed; please confirm."
        fi

        # All argv elements are script-controlled strings (no
        # operator-supplied substitutions land here unsanitized).
        # Invocation shape mirrors SYNTH_ARGS (Decision 1 / Req
        # 7.5 / 7.9 / 7.10): --agent vault-curator,
        # --dangerously-skip-permissions, --dir "$HOME", no
        # --continue (independent session).
        CURATOR_ARGS=(
          run
          --agent vault-curator
          --format json
          --dangerously-skip-permissions
          --dir "$HOME"
          "$CURATOR_PROMPT"
        )

        # Same tee-to-log + pipefail discipline as the synth
        # above (Req 9.AC4, 9.AC9). The curator's structured
        # return is NOT parsed by this script (4.3 only consumes
        # the marker), so no separate capture tempfile is needed
        # — tee to log (and to /dev/tty under --verbose) is
        # enough. The `if ... then curator_exit=0 else
        # curator_exit=''${PIPESTATUS[0]} fi` wrapper suspends
        # `set -e` so PIPESTATUS can be captured before the
        # script aborts on a non-zero curator exit; same pattern
        # as the synth block above.
        set -o pipefail
        if [ "$VERBOSE" = "true" ]; then
          if "$OPENCODE_BIN" "''${CURATOR_ARGS[@]}" 2>&1 \
              | tee -a "$LOG_FILE" \
              | tee /dev/tty > /dev/null
          then
            curator_exit=0
          else
            curator_exit=''${PIPESTATUS[0]}
          fi
        else
          if "$OPENCODE_BIN" "''${CURATOR_ARGS[@]}" 2>&1 \
              | tee -a "$LOG_FILE" > /dev/null
          then
            curator_exit=0
          else
            curator_exit=''${PIPESTATUS[0]}
          fi
        fi
        set +o pipefail

        if [ "$curator_exit" -ne 0 ]; then
          # Req 7.7 / 8.AC3: curator failed. Marker untouched
          # (Decision 7 — the synth's drafts are valid; re-running
          # memory-sync will re-process the same window and let
          # the next curator pass clean up any duplicates).
          # Footer captures the failure for the audit log;
          # release_lock + exit 2 here (the EXIT trap would also
          # fire). SYNTH_SUMMARY is preserved from
          # parse_synth_report so the footer's summary line still
          # reports the synth outcome even though the curator
          # failed afterward.
          EXIT_CODE=2
          SYNTH_SUMMARY="''${SYNTH_SUMMARY:-(none)}"
          MARKER_AFTER="<unchanged>"
          # Req 7.7: surface the curator's stderr to the operator's
          # stderr verbatim. Same approach as the synth-failure
          # branch above — the 2>&1 merge into $LOG_FILE holds the
          # verbatim bytes; replay the tail to the operator's stderr
          # BEFORE log_footer writes its block so the tailed lines
          # are the curator's actual output, not the script's
          # footer.
          if [ -f "$LOG_FILE" ]; then
            printf -- '--- last 20 lines of %s (curator output) ---\n' "$LOG_FILE" >&2
            tail -n 20 "$LOG_FILE" >&2
            printf -- '--- end of log tail ---\n' >&2
          fi
          log_footer
          # Concise operator-facing trailer naming the failure
          # class and the recovery action (Req 7.7, 8.AC3). The
          # parenthetical "(marker untouched)" reassures the
          # operator that re-running covers the same window — no
          # state to reconcile by hand.
          printf 'memory-sync: curator exited %d. Re-run memory-sync to retry the same window (marker untouched).\n' "$curator_exit" >&2
          release_lock
          exit 2
        fi
        # Curator succeeded — fall through to the marker-update
        # step (4.3). 4.3 owns the success-path log_footer + exit 0.
      fi
    fi

    # --- Success path: marker update + log footer + prune (task 4.3) ----
    #
    # Reached when:
    #   - synth succeeded (real run) or its dry-run announcement
    #     completed, AND
    #   - curator succeeded (real run), was skipped via --no-curator, or
    #     its dry-run announcement completed.
    # Both the dry-run branch (lines 850-878 above) and the real branch
    # (lines 879-1061 above) converge here after their respective
    # success paths complete; failure paths exit 1 / 2 earlier and
    # never reach this code.
    #
    # Step 1: marker-update branch (Req 3.AC6, 3.AC7, 7.AC8, 10.AC5).
    #   --dry-run         → print announcement, skip the write
    #   --since supplied  → skip the write (one-shot override)
    #   otherwise         → write_marker_atomic "$NOW"
    # MARKER_AFTER is set in all three sub-branches for the log_footer
    # (Req 9.AC6) and the operator summary.
    #
    # Step 2: log_footer with EXIT_CODE=0 and the parsed SYNTH_SUMMARY
    # (Req 9.AC6). log_footer is a no-op under --dry-run because
    # log_append short-circuits when DRY_RUN=true.
    #
    # Step 3: prune_logs (Req 9.AC7). The existing prune_logs helper
    # itself gates on DRY_RUN=true per Req 9.AC8, so an unconditional
    # call here is correct for both real-success and dry-run paths.
    #
    # Step 4: print_operator_summary — five-field human-readable summary
    # to stdout (task 4.3 body).
    #
    # Step 5: release_lock + exit 0 (Req 8.AC1). The EXIT trap would
    # also clean up the lock; the explicit release_lock matches the
    # synth-fail / curator-fail patterns above.
    if [ "$DRY_RUN" = "true" ]; then
      # Req 7.AC11 / 3.AC7 — dry-run announces the would-write but
      # SKIPS the marker mutation. The "DRY RUN:" prefix matches the
      # synth and curator dry-run announcement shapes above for a
      # uniform operator-facing trail on stdout.
      printf 'DRY RUN: would update marker to %s\n' "$NOW"
      MARKER_AFTER="<unchanged>"
    elif [ -n "$SINCE" ]; then
      # --since is a one-shot override; marker is left as-is so a
      # subsequent no-flag run still picks up from the persisted
      # marker (Req 3.AC6, 7.AC8, 10.AC5).
      MARKER_AFTER="<unchanged>"
    else
      # Standard success path: advance the marker atomically (Req
      # 3.AC7). write_marker_atomic exits 3 via release_lock on
      # failure, so a return from this call means the marker file now
      # contains exactly $NOW.
      write_marker_atomic "$NOW"
      MARKER_AFTER="$NOW"
    fi

    EXIT_CODE=0
    log_footer
    prune_logs
    print_operator_summary

    release_lock
    exit 0
  '';
}
