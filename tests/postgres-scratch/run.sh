#!/usr/bin/env bash
#
# `postgres-scratch`: the scratch-cluster contract check
# (spec postgres-cluster-on-the-fabro-host-for-litellm-a, task 5.3;
# Requirements 2.8, 3.3, 3.4, 3.6, 4.6, 4.7, 8.10-8.15).
#
# `default.nix` supplies the guest's own PostgreSQL package (PG_BINDIR), the
# guest's generated `fabro.postgres` SQL (BOOTSTRAP_SQL, OBJECT_GRANTS_SQL), and
# the declared fixture identities (DECLARED_DATABASES, DECLARED_ROLES). Every
# step prints `postgres-scratch: <step>`; a failure prints the offending
# database, role, or declaration and exits non-zero.
set -euo pipefail

# Stable diagnostics for the assertions below (the TCP probe matches bash's
# English refusal message) and stable `pg_dump` decoration.
export LC_ALL=C

: "${SCRATCH_ROOT:=$(mktemp -d "${TMPDIR:-/tmp}/postgres-scratch.XXXXXX")}"
export SCRATCH_ROOT
mkdir -p "$SCRATCH_ROOT"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./cluster.sh
# shellcheck disable=SC1091
. "${CLUSTER_SH:-$SCRIPT_DIR/cluster.sh}"

step() {
  printf 'postgres-scratch: %s\n' "$*"
}

fail() {
  printf 'postgres-scratch: FAILED: %s\n' "$*" >&2
  exit 1
}

require_variable() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    fail "$name is required; the check derivation must set it"
  fi
}

for variable in PG_BINDIR BOOTSTRAP_SQL OBJECT_GRANTS_SQL; do
  require_variable "$variable"
done

# Print the server log when a step fails, then stop the disposable cluster.
# `status` is assigned by the trap itself, so shellcheck cannot see it.
# shellcheck disable=SC2154
trap 'status=$?; if [ "$status" -ne 0 ] && [ -f "$PG_LOG" ]; then printf "postgres-scratch: server log follows (exit status %s)\n" "$status" >&2; tail -n 100 "$PG_LOG" >&2 || true; fi; stop_cluster' EXIT

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
    --username "$PG_SUPERUSER" --dbname "$database" >"$destination.raw" \
    || fail "pg_dump of database '$database' failed; the provisioned catalog cannot be compared"
  strip_dump_guards "$destination.raw" >"$destination"
}

# The ACLs the bootstrap and grant SQL own: the database ACL, the `public`
# schema ACL, and the owner's default ACLs. A second provisioning run must
# leave all three byte-identical.
litellm_catalog_snapshot() {
  pg_psql litellm --no-align --tuples-only --command "
    SELECT format('database-acl:%s', coalesce(datacl::text, ''))
      FROM pg_database WHERE datname = current_database()
    UNION ALL
    SELECT format('schema-acl:%s', coalesce(nspacl::text, ''))
      FROM pg_namespace WHERE nspname = 'public'
    UNION ALL
    SELECT format('default-acl:%s:%s', defaclobjtype, coalesce(defaclacl::text, ''))
      FROM pg_default_acl
    ORDER BY 1;
  "
}

apply_sql() {
  local label="$1"
  local file="$2"
  step "applying $label"
  "$PG_BINDIR/psql" --no-psqlrc \
    --host "$PG_SOCKET_DIR" --port "$PG_PORT" \
    --username "$PG_SUPERUSER" --dbname postgres \
    --set ON_ERROR_STOP=1 --echo-errors --file "$file" \
    || fail "$label failed; the fabro.postgres marker above names the failing declaration"
}

step "starting PostgreSQL with listen_addresses = '', socket $PG_SOCKET_DIR, port $PG_PORT"
start_cluster

step "asserting the pinned 18.6 server version"
server_version="$(pg_scalar postgres 'SHOW server_version')"
case "$server_version" in
  18.6*)
    ;;
  *)
    fail "the scratch cluster reports PostgreSQL '$server_version'; the guest pins 18.6 (Requirement 8.10)"
    ;;
esac

step "asserting pg_textsearch is preloaded"
preloaded="$(pg_scalar postgres 'SHOW shared_preload_libraries')"
case ",${preloaded// /}," in
  *,pg_textsearch,*)
    ;;
  *)
    fail "pg_textsearch is not in shared_preload_libraries (got '$preloaded'); the guest preloads it (Requirement 3.2)"
    ;;
esac

step "creating database scratch and installing the three extensions"
pg_psql postgres --command 'CREATE DATABASE scratch' >/dev/null
for extension in pg_textsearch vector pg_uuidv7; do
  if ! pg_psql scratch --command "CREATE EXTENSION \"$extension\"" >/dev/null; then
    fail "CREATE EXTENSION $extension failed in database scratch; services.postgresql.finalPackage must provide that extension package (Requirement 3.3)"
  fi
done

step "asserting uuid_generate_v7() returns a version-7 UUID"
uuid_value="$(pg_scalar scratch 'SELECT uuid_generate_v7()')"
uuid_pattern='^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
if ! [[ "$uuid_value" =~ $uuid_pattern ]]; then
  fail "uuid_generate_v7() returned '$uuid_value', which is not a version-7 UUID (Requirement 3.4)"
fi

step "asserting the vector extension version is at least 0.8.6"
vector_version="$(pg_scalar scratch "SELECT extversion FROM pg_extension WHERE extname = 'vector'")"
[ -n "$vector_version" ] ||
  fail "the vector extension is absent from database scratch (Requirement 3.3)"
lowest_version="$(printf '%s\n0.8.6\n' "$vector_version" | sort -V | head -n 1)"
if [ "$lowest_version" != "0.8.6" ]; then
  fail "the vector extension version is '$vector_version'; the guest requires 0.8.6 or later (Requirement 3.5)"
fi

step "connecting over the Unix socket"
[ -S "$PG_SOCKET" ] ||
  fail "no Unix socket at $PG_SOCKET; the cluster must listen on the socket directory (Requirement 2.1)"
socket_result="$(PGHOST="$PG_SOCKET_DIR" PGPORT="$PG_PORT" PGUSER="$PG_SUPERUSER" PGDATABASE=scratch \
  "$PG_BINDIR/psql" --no-psqlrc --no-align --tuples-only --command 'SELECT 1')"
[ "$socket_result" = "1" ] ||
  fail "the socket connection to $PG_SOCKET_DIR returned '$socket_result' instead of 1 (Requirement 2.1)"

step "asserting TCP 127.0.0.1:$PG_PORT is refused"
if "$PG_BINDIR/pg_isready" --host 127.0.0.1 --port "$PG_PORT" --timeout 5 >/dev/null 2>&1; then
  fail "pg_isready reached the cluster at 127.0.0.1:$PG_PORT; listen_addresses must be empty (Requirement 2.8)"
fi
tcp_probe_status=0
tcp_probe 127.0.0.1 "$PG_PORT" || tcp_probe_status=$?
case "$tcp_probe_status" in
  0)
    fail "a TCP connection to 127.0.0.1:$PG_PORT was accepted; the cluster must bind no TCP address (Requirement 8.13)"
    ;;
  1)
    ;;
  *)
    fail "the raw TCP probe to 127.0.0.1:$PG_PORT did not report a refusal, so socket-only exposure is unverified (Requirement 8.13)"
    ;;
esac

# The guest's declarations supply what the check provisions. An empty set
# would make both the SQL runs and the dump comparison vacuous, so treat it as
# a failure that names the missing interface input.
[ -n "${DECLARED_DATABASES:-}" ] ||
  fail "the guest declares no fabro.postgres databases; there is no provisioning SQL to exercise (Requirement 4.1)"
[ -n "${DECLARED_ROLES:-}" ] ||
  fail "the guest declares no fabro.postgres roles; there are no fixture identities to create (Requirement 4.1)"

step "creating the declared fixture databases"
for database in ${DECLARED_DATABASES:-}; do
  pg_psql postgres --command "CREATE DATABASE \"$database\"" >/dev/null ||
    fail "could not create declared database '$database' for the scratch fixture"
done

step "creating the declared fixture roles"
for role in ${DECLARED_ROLES:-}; do
  pg_psql postgres --command "CREATE ROLE \"$role\" LOGIN" >/dev/null ||
    fail "could not create declared role '$role' for the scratch fixture"
done

first_dump="$SCRATCH_ROOT/schema-first.sql"
apply_sql "the guest bootstrap SQL (first run)" "$BOOTSTRAP_SQL"
apply_sql "the guest object-grant SQL (first run)" "$OBJECT_GRANTS_SQL"
dump_schema litellm "$first_dump"
# A dump with only the pg_dump header would make the two-run comparison
# vacuous: the first run must have written the schema and default ACLs the
# declarations own.
if ! grep -qE '^(GRANT|REVOKE|ALTER DEFAULT PRIVILEGES)' "$first_dump"; then
  fail "the first provisioning run wrote no ACL statements to database litellm; the bootstrap and grant SQL must provision the declared grant set (Requirement 4.6)"
fi
first_catalog="$(litellm_catalog_snapshot)" ||
  fail "reading the litellm ACLs after the first provisioning run failed (Requirement 4.6)"

second_dump="$SCRATCH_ROOT/schema-second.sql"
apply_sql "the guest bootstrap SQL (second run)" "$BOOTSTRAP_SQL"
apply_sql "the guest object-grant SQL (second run)" "$OBJECT_GRANTS_SQL"
dump_schema litellm "$second_dump"
second_catalog="$(litellm_catalog_snapshot)" ||
  fail "reading the litellm ACLs after the second provisioning run failed (Requirement 4.6)"

step "asserting the second provisioning run changed no object"
if ! diff -u "$first_dump" "$second_dump" >"$SCRATCH_ROOT/schema-second.diff"; then
  cat "$SCRATCH_ROOT/schema-second.diff" >&2
  fail "the second provisioning run changed the catalog of database litellm; the bootstrap or grant SQL is not idempotent (Requirement 4.6)"
fi
if [ "$first_catalog" != "$second_catalog" ]; then
  printf '%s\n' "--- first run ACLs" "$first_catalog" "--- second run ACLs" "$second_catalog" >&2
  fail "the second provisioning run changed the database, schema, or default ACLs of litellm (Requirement 4.6)"
fi

step "asserting a run with the declared database absent fails and names the declaration"
pg_psql postgres --command 'DROP DATABASE litellm' >/dev/null
failed_run_log="$SCRATCH_ROOT/bootstrap-failed.log"
if "$PG_BINDIR/psql" --no-psqlrc \
  --host "$PG_SOCKET_DIR" --port "$PG_PORT" \
  --username "$PG_SUPERUSER" --dbname postgres \
  --set ON_ERROR_STOP=1 --echo-errors --file "$BOOTSTRAP_SQL" >"$failed_run_log" 2>&1; then
  fail "the bootstrap SQL succeeded with declared database litellm absent; a missing declaration must fail the unit (Requirement 4.8)"
fi
grep -Fq "fabro.postgres: database litellm" "$failed_run_log" ||
  fail "the failed bootstrap run did not name the litellm database declaration (Requirement 8.15)"
printf 'postgres-scratch: the failed run named the declaration: %s\n' \
  "$(grep -m 1 -F 'fabro.postgres: database litellm' "$failed_run_log")"

step "asserting provisioning converges after the failed run without manual cleanup"
pg_psql postgres --command 'CREATE DATABASE litellm' >/dev/null
apply_sql "the guest bootstrap SQL (convergence run 1)" "$BOOTSTRAP_SQL"
apply_sql "the guest object-grant SQL (convergence run 1)" "$OBJECT_GRANTS_SQL"
apply_sql "the guest bootstrap SQL (convergence run 2)" "$BOOTSTRAP_SQL"
apply_sql "the guest object-grant SQL (convergence run 2)" "$OBJECT_GRANTS_SQL"
converged_dump="$SCRATCH_ROOT/schema-converged.sql"
dump_schema litellm "$converged_dump"
if ! diff -u "$first_dump" "$converged_dump" >"$SCRATCH_ROOT/schema-converged.diff"; then
  cat "$SCRATCH_ROOT/schema-converged.diff" >&2
  fail "provisioning did not converge after a failed run: the catalog of database litellm differs from the clean first run (Requirement 4.7)"
fi

step "all scratch-cluster assertions passed"
