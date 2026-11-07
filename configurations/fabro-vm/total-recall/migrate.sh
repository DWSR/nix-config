#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'total-recall-migrate: %s\n' "$1" >&2
  exit 1
}

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  fail 'usage: total-recall-migrate <database-name>'
fi

DATABASE=$1
MIGRATION_DIR=${MIGRATION_DIR:?migration directory is not configured}
PG_SOCKET=/run/postgresql

migration_names=(
  0001_memory_schema_search.sql
  0001_harness_event_ledger.sql
  0002_session_embeddings.sql
  0001_session_post_processing.sql
)
for name in "${migration_names[@]}"; do
  [ -r "$MIGRATION_DIR/$name" ] || fail "migration source is missing: $name"
done

PSQL_ARGS=(
  --no-psqlrc
  --set=ON_ERROR_STOP=1
  --host="$PG_SOCKET"
  --username=postgres
  --dbname="$DATABASE"
)

apply_file() {
  local label=$1
  local path=$2
  if ! psql "${PSQL_ARGS[@]}" --file "$path"; then
    fail "failed applying $label"
  fi
}

apply_file bootstrap.sql "$MIGRATION_DIR/bootstrap.sql"

if ! applied_ledger=$(psql "${PSQL_ARGS[@]}" --tuples-only --no-align \
  --command "SELECT to_regclass('public.total_recall_schema_migrations');"); then
  fail 'failed checking the migration ledger'
fi
applied_ledger=$(printf '%s' "$applied_ledger" | tr -d '[:space:]')
if [ -z "$applied_ledger" ]; then
  if ! psql "${PSQL_ARGS[@]}" --command '
    SET ROLE memory_migration;
    CREATE TABLE public.total_recall_schema_migrations (
      name TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    GRANT SELECT ON public.total_recall_schema_migrations TO memory_application;
    RESET ROLE;
  '; then
    fail 'failed creating public.total_recall_schema_migrations'
  fi
fi

migration_hashes=()
for name in "${migration_names[@]}"; do
  path="$MIGRATION_DIR/$name"
  if ! hash=$(sha256sum "$path"); then
    fail "failed hashing migration $name"
  fi
  hash=${hash%% *}
  migration_hashes+=("$hash")

  if ! applied_hash=$(psql "${PSQL_ARGS[@]}" --tuples-only --no-align \
    --command "SELECT sha256 FROM public.total_recall_schema_migrations WHERE name = '$name';"); then
    fail "failed checking migration $name"
  fi
  applied_hash=$(printf '%s' "$applied_hash" | tr -d '[:space:]')
  if [ -n "$applied_hash" ] && [ "$applied_hash" != "$hash" ]; then
    fail "applied migration changed: $name"
  fi
done

for index in "${!migration_names[@]}"; do
  name=${migration_names[$index]}
  path="$MIGRATION_DIR/$name"
  hash=${migration_hashes[$index]}
  if ! applied_hash=$(psql "${PSQL_ARGS[@]}" --tuples-only --no-align \
    --command "SELECT sha256 FROM public.total_recall_schema_migrations WHERE name = '$name';"); then
    fail "failed checking migration $name"
  fi
  applied_hash=$(printf '%s' "$applied_hash" | tr -d '[:space:]')
  [ -z "$applied_hash" ] || continue

  if ! {
    printf 'BEGIN;\n'
    if [ "$name" != "0001_session_post_processing.sql" ]; then
      printf 'SET ROLE memory_migration;\n'
    fi
    printf -- '-- migration: %s\n' "$name"
    cat "$path"
    if [ "$name" = "0001_session_post_processing.sql" ]; then
      printf '\nSET ROLE memory_migration;\n'
      cat "$MIGRATION_DIR/runtime-grants.sql"
    fi
    printf '\nINSERT INTO public.total_recall_schema_migrations (name, sha256) VALUES (\047%s\047, \047%s\047);\n' "$name" "$hash"
    if [ "$name" != "0001_session_post_processing.sql" ]; then
      printf 'GRANT SELECT ON public.total_recall_schema_migrations TO memory_application;\nRESET ROLE;\n'
    fi
    printf 'COMMIT;\n'
  } | psql "${PSQL_ARGS[@]}"; then
    if [ "$name" = "0001_session_post_processing.sql" ]; then
      fail "failed applying migration $name or runtime-grants.sql"
    fi
    fail "failed applying migration $name"
  fi
done
