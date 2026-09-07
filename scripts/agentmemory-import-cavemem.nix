{
  writeShellApplication,
  nodejs,
  cavemem-importer-deps,
}:

writeShellApplication {
  name = "agentmemory-import-cavemem";
  runtimeInputs = [ nodejs ];
  text = ''
    # The importer opens cavemem read-only, backs it up to a temporary file,
    # reads only that copy, and submits standard AgentMemory skip batches.
    export NODE_PATH=${cavemem-importer-deps}/lib/node_modules
    # Expose GC so better-sqlite3's backup native handle is finalized before
    # the importer continues with HTTP work.
    exec ${nodejs}/bin/node --experimental-strip-types --expose-gc ${./agentmemory-import-cavemem.ts} "$@"
  '';
}
