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
        # Real main flow lands in tasks 2.3+. For now, fall through to
        # the bad-arg path. release_lock fires via the EXIT trap.
        usage
        exit 64
        ;;
    esac
  '';
}
