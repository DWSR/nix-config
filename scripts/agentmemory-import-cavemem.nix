{
  bearerReference,
  restEndpoint,
  writeShellApplication,
  coreutils,
  lib,
  nodejs_22,
  cavemem-importer-deps,
}:

writeShellApplication {
  name = "agentmemory-import-cavemem";
  runtimeInputs = [
    coreutils
    nodejs_22
  ];
  text = ''
    requires_secret=1
    for argument in "$@"; do
      case "$argument" in
        --dry-run|--help|-h) requires_secret=0 ;;
      esac
    done

    if [ "$requires_secret" -eq 1 ] && [ -z "''${AGENTMEMORY_SECRET:-}" ]; then
      security_bin="''${AGENTMEMORY_IMPORT_SECURITY_BIN:-/usr/bin/security}"
      agentmemory_secret=$(${coreutils}/bin/timeout --kill-after=2s 5s "$security_bin" find-generic-password -s mcpproxy -a ${lib.escapeShellArg bearerReference} -w 2>/dev/null) || agentmemory_secret=""
      if [ -z "$agentmemory_secret" ]; then
        echo "ERROR: AgentMemory bearer unavailable from macOS Keychain; import not started." >&2
        exit 1
      fi
      export AGENTMEMORY_SECRET="$agentmemory_secret"
    fi

    # The importer opens cavemem read-only, backs it up to a temporary file,
    # reads only that copy, and submits standard AgentMemory skip batches.
    export AGENTMEMORY_URL=${lib.escapeShellArg restEndpoint}
    export NODE_PATH=${cavemem-importer-deps}/lib/node_modules
    # Expose GC so better-sqlite3's backup native handle is finalized before
    # the importer continues with HTTP work.
    exec ${nodejs_22}/bin/node --experimental-strip-types --expose-gc ${./agentmemory-import-cavemem.ts} "$@"
  '';
}
