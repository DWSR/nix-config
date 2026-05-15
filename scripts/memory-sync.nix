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

    # mcphub HTTP base; the cavemem and obsidian probes (task 3.1) hit
    # /api/servers/info on this URL. Hardcoded per design Decision 6 +
    # cavemem-integration spec's mcphub-default-port memory.
    MCPHUB_BASE="http://localhost:37373"
    export MCPHUB_BASE

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
    # No-op when DRY_RUN=1 (Req 9.AC8).
    #
    # Inputs (read from caller scope, populated by main flow):
    #   NOW      — invocation timestamp (UTC ISO 8601), set by now_utc()
    #   LOG_DIR  — set at script init (top of the script)
    #   DRY_RUN  — 1 if --dry-run, else 0
    #
    # Outputs (set in caller scope):
    #   LOG_FILE — absolute path to the open log file
    #
    # The umask is applied BEFORE the first redirection so the resulting
    # file is created with mode 0600 (Req 9.AC10 — log files contain
    # potentially sensitive operator data; not world-readable).
    #
    # Currently unused by the script's own main flow; consumed by
    # tasks 4.x / 5.x.
    # shellcheck disable=SC2329  # consumed by tasks 4.x, 5.x
    open_log() {
      if [ "''${DRY_RUN:-0}" = "1" ]; then
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
    # when DRY_RUN=1 OR LOG_FILE is unset (open_log was skipped).
    #
    # Currently unused by the script's own main flow; consumed by
    # tasks 4.x / 5.x.
    # shellcheck disable=SC2329  # consumed by tasks 4.x, 5.x
    log_append() {
      if [ "''${DRY_RUN:-0}" = "1" ] || [ -z "''${LOG_FILE:-}" ]; then
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
    #   DRY_RUN          — 1 if --dry-run, else 0
    #   NO_CURATOR       — 1 if --no-curator, else 0
    #   VERBOSE          — 1 if --verbose, else 0
    #   OPENCODE_BIN     — baked at derivation time
    #
    # Currently unused by the script's own main flow; consumed by
    # tasks 4.x / 5.x.
    # shellcheck disable=SC2329  # consumed by tasks 4.x, 5.x
    log_header() {
      log_append "memory-sync run header"
      log_append "  invocation:  $NOW"
      log_append "  range:       $RANGE_START → $RANGE_END"
      log_append "  marker:      ''${MARKER_BEFORE:-<absent>} (before)"
      log_append "  flags:       --since=''${SINCE:-<unset>} --dry-run=''${DRY_RUN:-0} --no-curator=''${NO_CURATOR:-0} --verbose=''${VERBOSE:-0}"
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
      log_append "  summary:     ''${SYNTH_SUMMARY:-(none)}"
    }

    # prune_logs: keep only the 10 most recent log files in $LOG_DIR
    # (Req 9.AC7). Sorted by mtime via `ls -1t`; tail -n +11 outputs
    # the 11th-and-onward filenames, which xargs feeds to rm -f.
    # Safe when fewer than 11 files exist (tail produces no output).
    #
    # No-op when DRY_RUN=1 (Req 9.AC8).
    #
    # The pipeline runs from inside $LOG_DIR via a subshell so xargs
    # operates on bare filenames; the final `|| true` guards against a
    # partial-pipeline failure (e.g. ls finds nothing on first run).
    #
    # Currently unused by the script's own main flow; consumed by
    # task 4.3.
    # shellcheck disable=SC2329  # consumed by task 4.3
    prune_logs() {
      if [ "''${DRY_RUN:-0}" = "1" ]; then
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

    # tee_to_log <command...>: run a command and tee stdout+stderr
    # through $LOG_FILE (Req 9.AC4, 9.AC5). When VERBOSE=1, also tee
    # to /dev/tty so the operator sees progress in real time
    # (Req 9.AC9).
    #
    # The caller is responsible for not invoking this under DRY_RUN=1
    # (the dry-run code path should announce the would-be invocation
    # via stdout instead and skip the real command entirely; see Req
    # 7.AC11).
    #
    # Currently unused by the script's own main flow; consumed by
    # task 4.x.
    # shellcheck disable=SC2329  # consumed by task 4.x
    tee_to_log() {
      if [ "''${VERBOSE:-0}" = "1" ]; then
        "$@" 2>&1 | tee -a "$LOG_FILE" | tee /dev/tty > /dev/null
      else
        "$@" 2>&1 | tee -a "$LOG_FILE" > /dev/null
      fi
    }

    # probe_mcp_server <server-name> <exit-code-on-failure>
    # Pre-flight HTTP-transport health probe against mcphub
    # (Req 5.1, 5.2, 5.3, 5.4, 5.6; Decision 6 — pre-flight at the
    # HTTP-transport layer, NOT at the MCP-tool layer). Issues a
    # short-timeout (≤ 2s) POST to $MCPHUB_BASE/api/servers/info with
    # body {"server_name":"<name>"} and grep-asserts that the response
    # body contains "status":"connected". On any failure (curl non-2xx,
    # connect refused, timeout, OR a response whose status field is not
    # "connected"), prints an actionable two-line error to stderr naming
    # the server explicitly and the launchctl-kickstart recovery hint
    # (Req 5.2, 5.4, 8.5, 8.6), and exits with the supplied exit code.
    #
    # The endpoint shape is documented in
    # `memories/2026-05-14-mcp-hub-api-surface-and-wrapper-quoting.md`:
    # mcp-hub v4.2.1 does NOT expose `GET /api/servers/<name>` — that
    # path returns 404. The POST /api/servers/info shape was verified
    # live during the cavemem-integration spec's task 9.2 pass and is
    # the documented per-server status surface. The reference probe in
    # `home-manager/common/cavemem.nix:549-559` mirrors this shape; we
    # match its style (separate stderr lines, --max-time 2,
    # `"status":"connected"` grep) so failure-mode parity holds.
    #
    # Caller contract:
    #   - $MCPHUB_BASE must be set (top-of-script default is
    #     "http://localhost:37373").
    #   - Caller decides WHEN to invoke (after lock acquisition, before
    #     subagent spawn — Req 5.1).
    #   - Caller decides whether to suppress success output via --verbose
    #     gating; this helper is silent on success per Req 5.5.
    #
    # Wired into the post-lock pre-flight sequence below (cavemem first
    # with exit 4, then obsidian with exit 5) per Req 5.1, 5.3.
    probe_mcp_server() {
      local name="$1"
      local exit_code="$2"
      local body
      body="{\"server_name\":\"''${name}\"}"

      local response
      response=$(curl -sf --max-time 2 \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$body" \
        "$MCPHUB_BASE/api/servers/info" 2>/dev/null) || response=""

      if ! printf "%s" "$response" | grep -q "\"status\":\"connected\""; then
        echo "memory-sync: ERROR: ''${name} MCP unreachable." >&2
        echo "Recovery: launchctl kickstart gui/$(id -u)/com.ravitemer.mcp-hub" >&2
        exit "$exit_code"
      fi
    }

    usage() {
      cat <<'USAGE'
    memory-sync: orchestrate the cavemem → synthesizer → curator pipeline.

    (Skeleton; orchestration logic lands in tasks 2.x-4.x.)

    Usage:
      memory-sync [--help|-h]

    Options:
      --help, -h    Show this help and exit
    USAGE
    }

    case "''${1:-}" in
      --help|-h)
        usage
        exit 0
        ;;
      *)
        bootstrap_state_dir
        acquire_lock
        # Pre-flight MCP-transport probes (Req 5.1, 5.3; Decision 6).
        # Cavemem first because (a) Req 5.5 mandates exit 4 (not 5)
        # when only cavemem is down, and (b) per the task body,
        # cavemem is the more likely transient outage and a failure
        # here `exit`s inside probe_mcp_server before the obsidian
        # probe ever runs. probe_mcp_server is silent on success per
        # Req 5.5.
        probe_mcp_server cavemem 4
        probe_mcp_server obsidian 5
        # Verbose-mode liveness confirmation (Req 5.5 — only emit
        # health-check output under --verbose). The flag parser that
        # sets VERBOSE lands in task 3.3; until then, VERBOSE is
        # unset and the ''${VERBOSE:-} default-empty expansion keeps
        # this gate quiet under set -u. Once 3.3 ships, the bare
        # "$VERBOSE" form named in this task's body becomes safe;
        # the :- form is a forward-compatible superset (matches
        # both unset and "true"). Output goes to stderr so it joins
        # probe_mcp_server's own error stream and the upcoming
        # tee_to_log pipeline (which merges 2>&1 into the per-run
        # log) without contaminating stdout, which is reserved for
        # the success summary in task 4.x.
        if [ "''${VERBOSE:-}" = "true" ]; then
          printf 'memory-sync: cavemem and obsidian MCP servers reachable\n' >&2
        fi
        # Real main flow lands in tasks 3.3+. For now, fall through
        # to the bad-arg path. release_lock fires via the EXIT trap.
        usage
        exit 64
        ;;
    esac
  '';
}
