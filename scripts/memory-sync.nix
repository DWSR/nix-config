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
        usage
        exit 64
        ;;
    esac
  '';
}
