{
  writeShellApplication,
  nodejs,
  cavemem-importer-deps,
}:

writeShellApplication {
  name = "agentmemory-import-cavemem";
  runtimeInputs = [ nodejs ];
  text = ''
    # The importer is intentionally read-only. It opens cavemem in SQLite
    # readonly mode, backs it up to a temporary file, and reads only that copy.
    export NODE_PATH=${cavemem-importer-deps}/lib/node_modules
    exec ${nodejs}/bin/node --experimental-strip-types ${./agentmemory-import-cavemem.ts} "$@"
  '';
}
