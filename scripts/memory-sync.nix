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
        # Real main flow lands in tasks 2.2+. For now, fall through to
        # the bad-arg path so the skeleton's behavior is preserved.
        usage
        exit 64
        ;;
    esac
  '';
}
