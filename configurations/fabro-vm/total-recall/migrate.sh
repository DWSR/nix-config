#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'total-recall migration: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  fail 'usage: migrate.sh <database-name>'
fi
[[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail 'database name must be a PostgreSQL identifier'

database=$1
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
shared_dir="$script_dir/../share/total-recall"
migration_dir="$shared_dir/migrations"
psql=(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --username=postgres --host=/run/postgresql --dbname="$database")

run_file() {
  local file=$1
  local name=$2
  if ! "${psql[@]}" --file="$file"; then
    fail "failed applying $name"
  fi
}

run_sql() {
  local sql=$1
  "${psql[@]}" --command="$sql"
}

run_file "$shared_dir/bootstrap.sql" "bootstrap.sql"
ledger_exists=$(run_sql "SELECT to_regclass('public.total_recall_schema_migrations') IS NOT NULL") \
  || fail 'failed checking migration ledger'
if [ "$ledger_exists" != t ]; then
  if ! run_sql "SET ROLE memory_migration; CREATE TABLE public.total_recall_schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), applied_at TIMESTAMPTZ NOT NULL DEFAULT now()); RESET ROLE;"; then
    fail 'failed creating public.total_recall_schema_migrations'
  fi
fi

migration_names=(
  0001_memory_schema_search.sql
  0001_harness_event_ledger.sql
  0002_session_embeddings.sql
  0001_session_post_processing.sql
)
migration_roles=(
  memory_migration
  memory_migration
  memory_migration
  postgres
)
expected_hashes=()
actual_hashes=()

# Check all recorded checksums before applying any new migration.
for index in "${!migration_names[@]}"; do
  name=${migration_names[$index]}
  file="$migration_dir/$name"
  [ -f "$file" ] || fail "migration file is missing: $name"

  expected_hash=$(sha256sum "$file") || fail "failed hashing $name"
  expected_hash=${expected_hash%% *}
  actual_hash=$(run_sql "SELECT sha256 FROM public.total_recall_schema_migrations WHERE name = '$name'") \
    || fail "failed checking ledger entry for $name"
  if [ -n "$actual_hash" ] && [ "$actual_hash" != "$expected_hash" ]; then
    fail "applied migration hash changed: $name"
  fi
  expected_hashes[index]=$expected_hash
  actual_hashes[index]=$actual_hash
done

for index in "${!migration_names[@]}"; do
  [ -n "${actual_hashes[index]}" ] && continue
  name=${migration_names[$index]}
  file="$migration_dir/$name"
  role=${migration_roles[$index]}

  if ! {
    printf 'BEGIN;\nSET ROLE %s;\n' "$role"
    cat -- "$file"
    printf '\nRESET ROLE;\n'
    printf 'INSERT INTO public.total_recall_schema_migrations (name, sha256) VALUES (\047%s\047, \047%s\047);\nCOMMIT;\n' "$name" "${expected_hashes[index]}"
  } | "${psql[@]}"; then
    fail "failed applying $name"
  fi
done

run_file "$shared_dir/runtime-grants.sql" "runtime-grants.sql"
