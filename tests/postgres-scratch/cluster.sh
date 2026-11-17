#!/usr/bin/env bash
# Scratch-cluster helpers for the `postgres-scratch` repository check
# (spec postgres-cluster-on-the-fabro-host-for-litellm-a, task 5.3).
#
# `run.sh` sources this file. Every helper drives the guest's own PostgreSQL
# package over a temporary Unix socket directory on a non-default port: the
# same socket-only posture the guest renders, without the guest's systemd
# wiring. `PG_BINDIR` is the guest's `services.postgresql.finalPackage` bin
# directory, so a missing extension package fails here and not on the guest.

: "${PG_BINDIR:?postgres-scratch: PG_BINDIR must name the PostgreSQL package bin directory}"
: "${SCRATCH_ROOT:?postgres-scratch: SCRATCH_ROOT must name a writable scratch directory}"
: "${PG_PORT:=55432}"

PGDATA="$SCRATCH_ROOT/data"
PG_SOCKET_DIR="$SCRATCH_ROOT/run"
PG_LOG="$SCRATCH_ROOT/postgres.log"
PG_SUPERUSER=postgres
# Read by `run.sh` after it sources this file.
# shellcheck disable=SC2034
PG_SOCKET="$PG_SOCKET_DIR/.s.PGSQL.$PG_PORT"

# psql as the cluster superuser over the scratch socket. `ON_ERROR_STOP` turns
# any failing statement into a failing caller instead of a partial run.
pg_psql() {
  local database="$1"
  shift
  "$PG_BINDIR/psql" --no-psqlrc \
    --host "$PG_SOCKET_DIR" --port "$PG_PORT" \
    --username "$PG_SUPERUSER" --dbname "$database" \
    --set ON_ERROR_STOP=1 "$@"
}

# One unpadded, headerless scalar from the cluster.
pg_scalar() {
  pg_psql "$1" --no-align --tuples-only --command "$2"
}

# initdb keeps the cluster disposable, then the appended settings mirror the
# guest: no TCP address at all, a scratch socket directory, a non-default port,
# and the required preload. The non-default port and directory mean a green
# socket or TCP probe cannot be explained by a stray server on 5432 or /tmp.
# A missing or unloadable `pg_textsearch` library makes the server refuse to
# start, which is the contract Requirement 3.6 records.
start_cluster() {
  mkdir -p "$PG_SOCKET_DIR"

  "$PG_BINDIR/initdb" --pgdata "$PGDATA" --username "$PG_SUPERUSER" \
    --auth=trust --locale=C --encoding=UTF8 >/dev/null

  cat >>"$PGDATA/postgresql.conf" <<CONF
listen_addresses = ''
unix_socket_directories = '$PG_SOCKET_DIR'
port = $PG_PORT
shared_preload_libraries = 'pg_textsearch'
CONF

  if ! "$PG_BINDIR/pg_ctl" --pgdata "$PGDATA" --log "$PG_LOG" --wait start >/dev/null; then
    printf 'postgres-scratch: the cluster did not start; the guest preloads pg_textsearch (Requirement 3.6)\n' >&2
    sed -n '1,200p' "$PG_LOG" >&2 || true
    return 1
  fi
}

stop_cluster() {
  if [ -s "$PGDATA/postmaster.pid" ]; then
    "$PG_BINDIR/pg_ctl" --pgdata "$PGDATA" --mode=immediate --wait stop >/dev/null 2>&1 || true
  fi
}

# A direct connect(2) probe, independent of libpq's host and fallback rules.
# Returns 0 when the connection is accepted, 1 on a refused connection, and 2
# when the probe itself could not run (for example a bash without /dev/tcp).
# The third state keeps a broken probe from passing as a refusal.
tcp_probe() {
  local host="$1"
  local port="$2"
  local output
  if output="$(timeout 5 bash -c "exec 3<>/dev/tcp/$host/$port" 2>&1)"; then
    return 0
  fi
  case "$output" in
    *"Connection refused"*)
      return 1
      ;;
    *)
      printf 'postgres-scratch: the TCP probe to %s:%s failed unexpectedly: %s\n' \
        "$host" "$port" "$output" >&2
      return 2
      ;;
  esac
}
