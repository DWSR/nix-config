{
  pkgs,
  totalRecall,
}:
let
  migrationFiles = pkgs.runCommand "total-recall-migration-sources" { } ''
    mkdir -p "$out"
    cp "${totalRecall.outPath}/crates/memory-store/migrations/0001_memory_schema_search.sql" \
      "$out/0001_memory_schema_search.sql"
    cp "${totalRecall.outPath}/workers/harness-event-persistence/migrations/0001_harness_event_ledger.sql" \
      "$out/0001_harness_event_ledger.sql"
    cp "${totalRecall.outPath}/workers/harness-event-persistence/migrations/0002_session_embeddings.sql" \
      "$out/0002_session_embeddings.sql"
    cp "${totalRecall.outPath}/workers/session-post-processing/migrations/0001_session_post_processing.sql" \
      "$out/0001_session_post_processing.sql"
    cp "${./bootstrap.sql}" "$out/bootstrap.sql"
    cp "${./runtime-grants.sql}" "$out/runtime-grants.sql"
  '';
in
pkgs.writeShellApplication {
  name = "total-recall-migrate";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.unstable.postgresql_17
  ];
  text = ''
    ${builtins.readFile ./migrate.sh}
  '';
  runtimeEnv.MIGRATION_DIR = toString migrationFiles;
}
