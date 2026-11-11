{
  lib,
  stdenvNoCC,
  makeWrapper,
  coreutils,
  postgresql,
  totalRecall,
}:

let
  source = totalRecall.harness-ingestion.src;
  migrationFiles = [
    {
      source = "${source}/crates/memory-store/migrations/0001_memory_schema_search.sql";
      name = "0001_memory_schema_search.sql";
    }
    {
      source = "${source}/workers/harness-event-persistence/migrations/0001_harness_event_ledger.sql";
      name = "0001_harness_event_ledger.sql";
    }
    {
      source = "${source}/workers/harness-event-persistence/migrations/0002_session_embeddings.sql";
      name = "0002_session_embeddings.sql";
    }
    {
      source = "${source}/workers/session-post-processing/migrations/0001_session_post_processing.sql";
      name = "0001_session_post_processing.sql";
    }
  ];
in
stdenvNoCC.mkDerivation {
  pname = "total-recall-migrate";
  version = "1";
  dontUnpack = true;
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/share/total-recall/migrations"
    install -m 0555 ${./migrate.sh} "$out/bin/migrate.sh"
    install -m 0444 ${./bootstrap.sql} "$out/share/total-recall/bootstrap.sql"
    install -m 0444 ${./runtime-grants.sql} "$out/share/total-recall/runtime-grants.sql"
  ''
  + lib.concatMapStringsSep "\n" (migration: ''
    install -m 0444 ${migration.source} "$out/share/total-recall/migrations/${migration.name}"
  '') migrationFiles
  + ''
    runHook postInstall
  '';

  postFixup = ''
    wrapProgram "$out/bin/migrate.sh" \
      --prefix PATH : ${
        lib.makeBinPath [
          coreutils
          postgresql
        ]
      }
  '';

  passthru.migrationFiles = map (migration: migration.source) migrationFiles;
  meta = {
    description = "Idempotent PostgreSQL migration runner for total-recall";
    mainProgram = "migrate.sh";
    platforms = lib.platforms.linux;
  };
}
