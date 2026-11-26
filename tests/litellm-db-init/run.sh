#!/usr/bin/env bash
#
# `litellm-db-init`: the schema-initialization contract check
# (spec postgres-cluster-on-the-fabro-host-for-litellm-a, task 5.4;
# Requirements 5.6-5.10, 7.4, 7.5, 7.8, 7.12, 8.15).
#
# `default.nix` supplies the guest's own PostgreSQL package (PG_BINDIR), the
# installed `litellm-db-init` script (LITELLM_DB_INIT), the guest `litellm-db`
# package's pinned schema (LITELLM_SCHEMA), the guest's generated
# `fabro.postgres` SQL (BOOTSTRAP_SQL, OBJECT_GRANTS_SQL), and the declared
# fixture identities (DECLARED_DATABASES, DECLARED_ROLES). Every step prints
# `litellm-db-init: <step>`; a failure names the offending table, view, role,
# or step and exits non-zero.
set -euo pipefail

# Stable diagnostics for the assertions below and stable `pg_dump` decoration.
export LC_ALL=C

: "${SCRATCH_ROOT:=$(mktemp -d "${TMPDIR:-/tmp}/litellm-db-init.XXXXXX")}"
export SCRATCH_ROOT
mkdir -p "$SCRATCH_ROOT"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../postgres-scratch/cluster.sh
# shellcheck disable=SC1091
. "${CLUSTER_SH:-$SCRIPT_DIR/../postgres-scratch/cluster.sh}"

# The guest's declared identities and the pinned LiteLLM schema the check
# expects the installed script to apply. The names below must appear in
# DECLARED_DATABASES/DECLARED_ROLES; a renamed declaration fails the check
# instead of silently provisioning a fixture the guest no longer has.
LITELLM_DATABASE=litellm
MIGRATION_ROLE=litellm_migrator
APP_ROLE=litellm_app

# The script's own `psql` reads PGHOST/PGPORT/PGUSER/PGDATABASE (Prisma reads
# DATABASE_URL), so the check exports the scratch socket coordinates exactly as
# the guest's unit sets them. `run_init` overrides PGDATABASE per database.
export PGHOST="$PG_SOCKET_DIR"
# shellcheck disable=SC2153  # PG_PORT is assigned by the sourced cluster.sh
export PGPORT="$PG_PORT"
export PGUSER="$MIGRATION_ROLE"

# `prisma db push` creates one table per `model` block in the pinned
# schema.prisma; LiteLLM 1.108.0 declares 101 models. The eight views are the
# body of `litellm-views.sql`, which the script applies after the push.
EXPECTED_TABLES=101
EXPECTED_VIEWS=(
  LiteLLM_VerificationTokenView
  MonthlyGlobalSpend
  Last30dKeysBySpend
  Last30dModelsBySpend
  MonthlyGlobalSpendPerKey
  MonthlyGlobalSpendPerUserPerKey
  Last30dTopEndUsersSpend
  DailyTagSpend
)

# A separate database for the destructive fixture: the real `litellm`
# database must never see the table the pinned schema does not declare.
FIXTURE_DATABASE=litellm_db_init_fixture
FIXTURE_TABLE=litellm_fixture_should_not_drop

step() {
  printf 'litellm-db-init: %s\n' "$*"
}

fail() {
  printf 'litellm-db-init: FAILED: %s\n' "$*" >&2
  exit 1
}

require_variable() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "$name is required; the check derivation must set it"
  fi
}

for variable in PG_BINDIR BOOTSTRAP_SQL OBJECT_GRANTS_SQL LITELLM_DB_INIT LITELLM_SCHEMA; do
  require_variable "$variable"
done

# Print the server log when a step fails, then stop the disposable cluster.
# `status` is assigned by the trap itself, so shellcheck cannot see it.
# shellcheck disable=SC2154
trap 'status=$?; if [ "$status" -ne 0 ] && [ -f "$PG_LOG" ]; then printf "litellm-db-init: server log follows (exit status %s)\n" "$status" >&2; tail -n 100 "$PG_LOG" >&2 || true; fi; stop_cluster' EXIT

require_declared() {
  local what="$1"
  local declared="$2"
  local name="$3"
  case " ${declared} " in
    *" ${name} "*)
      ;;
    *)
      fail "the guest declares no $what '$name' (declared: '${declared:-<none>}'); the schema-initialization check provisions the guest's declaration set"
      ;;
  esac
}

# Newer `pg_dump` releases bracket their output with a per-run
# `\restrict`/`\unrestrict` token. Strip those guard lines when they are
# present so two dumps of the same catalog compare equal; every other line,
# including the ACL statements, must match.
strip_dump_guards() {
  sed -E '/^\\(un)?restrict( |$)/d' "$1"
}

dump_schema() {
  local database="$1"
  local destination="$2"
  "$PG_BINDIR/pg_dump" --schema-only \
    --host "$PG_SOCKET_DIR" --port "$PG_PORT" \
    --username "$PG_SUPERUSER" --dbname "$database" >"$destination.raw" ||
    fail "pg_dump of database '$database' failed; the provisioned catalog cannot be compared"
  strip_dump_guards "$destination.raw" >"$destination"
}

# `psql` as one of the guest's declared roles over the scratch socket. `trust`
# authentication accepts the role name without a password, exactly like the
# guest's socket-only peer authentication: the check exercises the role's real
# privileges, not the superuser's.
role_psql() {
  local role="$1"
  local database="$2"
  shift 2
  "$PG_BINDIR/psql" --no-psqlrc \
    --host "$PG_SOCKET_DIR" --port "$PG_PORT" \
    --username "$role" --dbname "$database" \
    --set ON_ERROR_STOP=1 "$@"
}

# Apply one of the guest's generated provisioning files as the cluster
# superuser, the way the `postgres-bootstrap` and `postgres-grants` oneshots
# run. The `fabro.postgres` markers stay visible, and a failed statement prints
# before the check's message.
apply_sql() {
  local label="$1"
  local file="$2"
  local log="$3"
  step "applying $label"
  if ! "$PG_BINDIR/psql" --no-psqlrc \
    --host "$PG_SOCKET_DIR" --port "$PG_PORT" \
    --username "$PG_SUPERUSER" --dbname postgres \
    --set ON_ERROR_STOP=1 --echo-errors --file "$file" >"$log" 2>&1; then
    cat "$log" >&2
    fail "$label failed; the fabro.postgres marker above names the failing declaration"
  fi
  cat "$log"
}

# The connection URL the unit hands Prisma: the guest uses the default 5432
# port on the socket path, the scratch cluster uses its own socket directory
# and non-default port, so the authority carries the port the way Prisma 5.17
# parses it and `host` names the socket directory.
database_url() {
  local database="$1"
  printf 'postgresql://%s@localhost:%s/%s?host=%s' \
    "$MIGRATION_ROLE" "$PG_PORT" "$database" "$PG_SOCKET_DIR"
}

# Run the installed script as the migration role. `DATABASE_URL` drives Prisma
# and `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE` drive the script's own `psql`,
# mirroring the unit's environment matrix; the Prisma CLI wrapper already
# exports both pinned engine paths. The script must exit zero, and its output
# is printed under the check's prefix so a Prisma or `psql` failure names the
# failing step.
run_init() {
  local label="$1"
  local database="$2"
  local log="$3"
  step "running the installed litellm-db-init script against database $database ($label)"
  if ! DATABASE_URL="$(database_url "$database")" \
    PGDATABASE="$database" \
    HOME="$SCRATCH_ROOT/home" \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    "$LITELLM_DB_INIT" >"$log" 2>&1; then
    cat "$log" >&2
    fail "the $label litellm-db-init run failed; the Prisma or psql error above names the failing statement"
  fi
  sed 's/^/litellm-db-init:   /' "$log"
}

# The first thing to fail fast: the installed script must still apply the
# guest's own schema with the non-destructive flags. `--accept-data-loss` or
# `--force-reset` would let a destructive change drop data, and a different
# `--schema` would push a schema the proxy was not built against.
step "asserting the installed script applies the pinned schema with non-destructive flags"
grep -Fq -- "db push --skip-generate --schema $LITELLM_SCHEMA" "$LITELLM_DB_INIT" ||
  fail "the installed script must run 'prisma db push --skip-generate --schema $LITELLM_SCHEMA' (Requirement 7.12); the installed text no longer matches the guest's schema"
for forbidden in --accept-data-loss --force-reset; do
  if grep -Fq -- "$forbidden" "$LITELLM_DB_INIT"; then
    fail "the installed script passes '$forbidden'; a destructive schema change must fail and name the change instead of dropping data (Requirement 7.8)"
  fi
done

step "asserting the pinned schema declares $EXPECTED_TABLES Prisma models"
model_count="$(grep -c '^model ' "$LITELLM_SCHEMA")" ||
  fail "could not read the Prisma schema $LITELLM_SCHEMA; the init script's schema must be in the guest's litellm-db closure"
if [ "$model_count" != "$EXPECTED_TABLES" ]; then
  fail "the guest's pinned schema declares $model_count model blocks; this check and the design expect $EXPECTED_TABLES Prisma tables for LiteLLM 1.108.0 (Requirement 7.4)"
fi

step "starting PostgreSQL with listen_addresses = '', socket $PG_SOCKET_DIR, port $PG_PORT"
start_cluster

step "asserting the pinned 18.6 server version"
server_version="$(pg_scalar postgres 'SHOW server_version')"
case "$server_version" in
  18.6*)
    ;;
  *)
    fail "the scratch cluster reports PostgreSQL '$server_version'; the guest pins 18.6"
    ;;
esac

require_declared database "$DECLARED_DATABASES" "$LITELLM_DATABASE"
require_declared role "$DECLARED_ROLES" "$MIGRATION_ROLE"
require_declared role "$DECLARED_ROLES" "$APP_ROLE"
if [ "$MIGRATION_ROLE" = "$APP_ROLE" ]; then
  fail "the schema-initialization role and the application role are both '$APP_ROLE'; the guest requires two distinct roles (Requirement 5.5)"
fi

step "creating the declared fixture database $LITELLM_DATABASE"
pg_psql postgres --command "CREATE DATABASE \"$LITELLM_DATABASE\"" >/dev/null ||
  fail "could not create declared database '$LITELLM_DATABASE' for the scratch fixture"

step "creating the declared fixture roles $MIGRATION_ROLE and $APP_ROLE"
for role in "$MIGRATION_ROLE" "$APP_ROLE"; do
  pg_psql postgres --command "CREATE ROLE \"$role\" LOGIN" >/dev/null ||
    fail "could not create declared role '$role' for the scratch fixture"
done

apply_sql "the guest bootstrap SQL" "$BOOTSTRAP_SQL" "$SCRATCH_ROOT/bootstrap.log"
apply_sql "the guest object-grant SQL" "$OBJECT_GRANTS_SQL" "$SCRATCH_ROOT/grants.log"

run_init "first run" "$LITELLM_DATABASE" "$SCRATCH_ROOT/init-first.log"

step "asserting the first run created the $EXPECTED_TABLES Prisma tables"
table_count="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" ||
  fail "counting the tables in database $LITELLM_DATABASE failed"
if [ "$table_count" != "$EXPECTED_TABLES" ]; then
  fail "the first litellm-db-init run created $table_count public tables in $LITELLM_DATABASE; the pinned schema declares $EXPECTED_TABLES (Requirement 7.4)"
fi

step "asserting every one of the $EXPECTED_TABLES Prisma tables is owned by $MIGRATION_ROLE"
foreign_tables="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tableowner <> '$MIGRATION_ROLE'")" ||
  fail "reading the table owners of database $LITELLM_DATABASE failed"
if [ "$foreign_tables" != 0 ]; then
  fail "$foreign_tables Prisma tables in $LITELLM_DATABASE are not owned by $MIGRATION_ROLE; the schema-initialization role must own every object it creates (Requirement 5.6)"
fi

step "asserting the first run created the eight LiteLLM views"
view_count="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM pg_views WHERE schemaname = 'public'")" ||
  fail "counting the views in database $LITELLM_DATABASE failed"
if [ "$view_count" != "${#EXPECTED_VIEWS[@]}" ]; then
  fail "the first litellm-db-init run created $view_count public views in $LITELLM_DATABASE; litellm-views.sql defines ${#EXPECTED_VIEWS[@]} views (Requirement 5.6)"
fi
for view in "${EXPECTED_VIEWS[@]}"; do
  present="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewname = '$view'")" ||
    fail "querying pg_views for view $view in database $LITELLM_DATABASE failed"
  if [ "$present" != 1 ]; then
    fail "view $view is missing from database $LITELLM_DATABASE; litellm-views.sql must define all eight LiteLLM views (Requirement 5.6)"
  fi
done
foreign_views="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM pg_views WHERE schemaname = 'public' AND viewowner <> '$MIGRATION_ROLE'")" ||
  fail "reading the view owners of database $LITELLM_DATABASE failed"
if [ "$foreign_views" != 0 ]; then
  fail "$foreign_views LiteLLM views in $LITELLM_DATABASE are not owned by $MIGRATION_ROLE; the schema-initialization role must own every object the step creates (Requirement 5.6)"
fi

step "asserting LiteLLM_VerificationTokenView exposes project_alias"
aliased="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'LiteLLM_VerificationTokenView' AND column_name = 'project_alias'")" ||
  fail "querying the columns of LiteLLM_VerificationTokenView failed"
if [ "$aliased" != 1 ]; then
  fail "LiteLLM_VerificationTokenView has no project_alias column; the pinned view must expose the project alias (Requirement 5.6)"
fi

# The guest runs `postgres-grants` after the schema-initialization unit so the
# migration role's tables and the pre-created views reach the application role.
# Re-apply the same generated file after the first init run, with only the
# `objectGrantsSqlFile` content, to mirror that ordering.
apply_sql "the guest object-grant SQL after schema initialization" "$OBJECT_GRANTS_SQL" "$SCRATCH_ROOT/grants-after-init.log"

step "asserting $APP_ROLE can read a migrator-owned table and view"
if ! role_psql "$APP_ROLE" "$LITELLM_DATABASE" --no-align --tuples-only --command 'SELECT count(*) FROM "LiteLLM_Config"' >/dev/null; then
  fail "$APP_ROLE cannot SELECT from the migrator-owned table LiteLLM_Config; the guest must grant the application role the table DML privileges the proxy needs (Requirement 5.7)"
fi
if ! role_psql "$APP_ROLE" "$LITELLM_DATABASE" --no-align --tuples-only --command 'SELECT count(*) FROM "LiteLLM_VerificationTokenView"' >/dev/null; then
  fail "$APP_ROLE cannot SELECT from LiteLLM_VerificationTokenView; the guest must grant the application role the view privileges the proxy needs (Requirement 5.7)"
fi

step "asserting $APP_ROLE can insert and delete a migrator-owned row"
if ! role_psql "$APP_ROLE" "$LITELLM_DATABASE" --no-align --tuples-only \
  --command "INSERT INTO \"LiteLLM_Config\" (param_name, param_value) VALUES ('litellm-db-init-check', '1'::jsonb)" >/dev/null; then
  fail "$APP_ROLE cannot INSERT into LiteLLM_Config; the guest must grant the application role the table DML privileges the proxy needs (Requirement 5.7)"
fi
if ! role_psql "$APP_ROLE" "$LITELLM_DATABASE" --no-align --tuples-only \
  --command "DELETE FROM \"LiteLLM_Config\" WHERE param_name = 'litellm-db-init-check'" >/dev/null; then
  fail "$APP_ROLE cannot DELETE from LiteLLM_Config; the guest must grant the application role the table DML privileges the proxy needs (Requirement 5.7)"
fi
# The shipped views are join or aggregate views and are not insertable; the DML
# contract is the table INSERT/DELETE above plus read access to the views.
remaining="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM \"LiteLLM_Config\" WHERE param_name = 'litellm-db-init-check'")" ||
  fail "reading the application role's test row from LiteLLM_Config failed"
if [ "$remaining" != 0 ]; then
  fail "the application role's DELETE from LiteLLM_Config left a row behind; the check cannot prove writable access"
fi

step "asserting $APP_ROLE cannot create a table in schema public"
app_ddl_log="$SCRATCH_ROOT/app-ddl.log"
if role_psql "$APP_ROLE" "$LITELLM_DATABASE" --command 'CREATE TABLE "litellm_app_ddl_probe" (id integer)' >"$app_ddl_log" 2>&1; then
  fail "$APP_ROLE created a table in $LITELLM_DATABASE; the application role must hold no CREATE on the database or schema public (Requirement 5.8)"
fi
if ! grep -Fq 'permission denied for schema public' "$app_ddl_log"; then
  cat "$app_ddl_log" >&2
  fail "$APP_ROLE's CREATE TABLE failed without 'permission denied for schema public'; the error above is the unexpected failure (Requirement 5.8)"
fi

first_dump="$SCRATCH_ROOT/schema-first.sql"
dump_schema "$LITELLM_DATABASE" "$first_dump"

run_init "second run" "$LITELLM_DATABASE" "$SCRATCH_ROOT/init-second.log"
if ! grep -Fq 'already in sync' "$SCRATCH_ROOT/init-second.log"; then
  cat "$SCRATCH_ROOT/init-second.log" >&2
  fail "the second litellm-db-init run did not report the Prisma schema as already in sync; a repeat run must change no object (Requirement 7.5)"
fi

second_dump="$SCRATCH_ROOT/schema-second.sql"
dump_schema "$LITELLM_DATABASE" "$second_dump"

step "asserting the second run changed no object in $LITELLM_DATABASE"
if ! diff -u "$first_dump" "$second_dump" >"$SCRATCH_ROOT/schema-second.diff"; then
  cat "$SCRATCH_ROOT/schema-second.diff" >&2
  fail "the second litellm-db-init run changed the catalog of database $LITELLM_DATABASE; the Prisma push or the eight views are not idempotent (Requirement 7.5)"
fi

# A destructive fixture change: a separate database carries the pinned schema
# plus a non-empty table the schema does not declare. The installed script must
# refuse to drop it, name the table, and leave the fixture database and the
# real `litellm` database intact. A `--accept-data-loss` added to the script
# would make this run succeed and fail the check.
step "creating the destructive fixture database $FIXTURE_DATABASE"
pg_psql postgres --command "CREATE DATABASE \"$FIXTURE_DATABASE\" OWNER \"$MIGRATION_ROLE\"" >/dev/null ||
  fail "could not create the destructive fixture database '$FIXTURE_DATABASE'"
run_init "first fixture run" "$FIXTURE_DATABASE" "$SCRATCH_ROOT/fixture-first.log"

step "adding the non-empty fixture table $FIXTURE_TABLE the pinned schema does not declare"
if ! role_psql "$MIGRATION_ROLE" "$FIXTURE_DATABASE" \
  --command "CREATE TABLE \"$FIXTURE_TABLE\" (id integer PRIMARY KEY)" \
  --command "INSERT INTO \"$FIXTURE_TABLE\" (id) VALUES (1)" >/dev/null; then
  fail "could not add the destructive fixture table $FIXTURE_TABLE as $MIGRATION_ROLE"
fi

step "asserting the destructive fixture change fails the installed script"
fixture_rerun_log="$SCRATCH_ROOT/fixture-destructive.log"
if DATABASE_URL="$(database_url "$FIXTURE_DATABASE")" \
  PGDATABASE="$FIXTURE_DATABASE" \
  HOME="$SCRATCH_ROOT/home" \
  CHECKPOINT_DISABLE=1 \
  PRISMA_HIDE_UPDATE_MESSAGE=1 \
  "$LITELLM_DB_INIT" >"$fixture_rerun_log" 2>&1; then
  cat "$fixture_rerun_log" >&2
  fail "litellm-db-init succeeded on a fixture database whose schema would drop the non-empty table $FIXTURE_TABLE; the script must not pass --accept-data-loss or --force-reset (Requirement 7.8)"
fi
cat "$fixture_rerun_log" >&2
if ! grep -Fq "$FIXTURE_TABLE" "$fixture_rerun_log"; then
  fail "the failed litellm-db-init run did not name the destructive table $FIXTURE_TABLE; the failure must name the change instead of dropping the data (Requirement 7.8)"
fi
if ! grep -Fq 'data loss' "$fixture_rerun_log"; then
  fail "the failed litellm-db-init run did not report the change as data loss; the destructive fixture was rejected for another reason (Requirement 7.8)"
fi

step "asserting the failed run left the fixture data and the real database intact"
fixture_rows="$(pg_scalar "$FIXTURE_DATABASE" "SELECT count(*) FROM \"$FIXTURE_TABLE\"")" ||
  fail "reading the destructive fixture row after the failed run failed; the defensive assertion below cannot run (Requirement 7.8)"
if [ "$fixture_rows" != 1 ]; then
  fail "the failed litellm-db-init run dropped or changed the destructive fixture row (found $fixture_rows rows); a destructive change must fail without touching the database (Requirement 7.8)"
fi
real_tables="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")" ||
  fail "reading database $LITELLM_DATABASE after the destructive fixture run failed"
real_views="$(pg_scalar "$LITELLM_DATABASE" "SELECT count(*) FROM pg_views WHERE schemaname = 'public'")" ||
  fail "reading the views of database $LITELLM_DATABASE after the destructive fixture run failed"
if [ "$real_tables" != "$EXPECTED_TABLES" ] || [ "$real_views" != "${#EXPECTED_VIEWS[@]}" ]; then
  fail "the destructive fixture run changed the real $LITELLM_DATABASE (tables $real_tables/$EXPECTED_TABLES, views $real_views/${#EXPECTED_VIEWS[@]}); the fixture must live in its own database (Requirement 7.8)"
fi

step "dropping the destructive fixture database $FIXTURE_DATABASE"
pg_psql postgres --command "DROP DATABASE \"$FIXTURE_DATABASE\"" >/dev/null ||
  fail "could not drop the destructive fixture database '$FIXTURE_DATABASE'"

trap - EXIT
stop_cluster
step "all schema-initialization assertions passed"
