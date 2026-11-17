# PostgreSQL and LiteLLM database runbook

The fabro guest runs one socket-only PostgreSQL 18.6 cluster. LiteLLM
1.86.0 keeps its virtual keys, spend logs, and admin UI users in the
`litellm` database of that cluster. The cluster binds no TCP address, uses
peer authentication over the Unix socket, and stores no database password.
This document records where the cluster's files live, how the
`fabro.postgres` declarations turn into databases and roles, how to inspect
the LiteLLM schema initialization, and the five operator smoke steps with
their expected observations.

## Paths

| What | Path | Notes |
| --- | --- | --- |
| Cluster data directory (`PGDATA`) | `/var/lib/postgresql/18` | Owned by the `postgres` account. A switch reuses it, so databases, roles, and rows survive; nothing in this configuration drops an object. |
| Socket directory (`unix_socket_directories`) | `/run/postgresql` | The cluster's only endpoint. `/run/postgresql/.s.PGSQL.5432` exists while the server runs; the directory is tmpfs and recreated at boot. `listen_addresses` is the empty string, so port 5432 is configured but never bound. |
| LiteLLM state directory (`services.litellm.stateDir`) | `/var/lib/litellm` | The proxy's `HOME`, `StateDirectory=litellm`, and the parent of `ui/` (admin UI runtime files), `tiktoken-cache/`, and `chatgpt/auth.json` (the operator's ChatGPT OAuth credential). It persists across switches and reboots. |
| Declaration surface | `config.fabro.postgres` | The only source of workload databases, roles, extensions, grants, and schema-init units. The option tree is declared in `configurations/fabro-vm/postgres.nix`. |
| Current LiteLLM declarations | `configurations/fabro-vm/litellm-db.nix` | Declares the `litellm` database, `litellm_migrator` and `litellm_app`, the grants, and `litellm-db-init.service`. A future workload adds its own `fabro.postgres` fragment in its module. |

`fabro.postgres` is one option tree, not one file: the interface lives in
`configurations/fabro-vm/postgres.nix`, the guest's populated declaration
lives in `configurations/fabro-vm/litellm-db.nix`, and a new workload adds
its fragment to that workload's module. There is no second declaration
source. `fabro.postgres` is projected into
`services.postgresql.ensureDatabases`, `ensureUsers`, `authentication`, and
`identMap`, and into the generated bootstrap and grant SQL. Do not edit
`services.postgresql` directly, do not hand-write provisioning SQL, and do
not create workload databases or roles by hand: the next switch would not
know about them.

## Editing the declarations

Every kind of object is added the same way: add or change a value under
`fabro.postgres` in `configurations/fabro-vm/litellm-db.nix` (or the
module of the workload that owns the object), then switch the guest.

| Option | Declares |
| --- | --- |
| `fabro.postgres.databases.<name>` | A workload database's owner and extensions. |
| `fabro.postgres.roles.<name>` | A login role's `systemUser` and `connectionLimit`. |
| `fabro.postgres.databases.<name>.extensions` | The SQL extensions installed in that database. |
| `fabro.postgres.grants` | The database, schema, table, and sequence privileges per role. |
| `fabro.postgres.schemaInitUnits` | The units that initialize a workload's schema. |

Database, role, and system-account names must match `[a-z_][a-z0-9_]*`. A
`systemUser` may also contain hyphens. The name `postgres` is reserved for
the cluster superuser; every database owner and grant target must be a
declared role, and every `systemUser` must exist in `users.users`, or
evaluation fails naming the option path.

### Add a database

```nix
fabro.postgres.databases.example = {
  owner = "example_migrator";
  extensions = [ "pg_uuidv7" ];
};
```

`owner` must be a declared role. On a switch, `postgresql-setup.service`
creates a missing database as `postgres`, then
`postgres-bootstrap.service` changes its owner to the declared role with a
guarded `ALTER DATABASE`. An existing database that already has the
declared owner is left untouched, and a database removed from the
declaration is never dropped.

### Add a role

```nix
fabro.postgres.roles.example_migrator.systemUser = "example-migrator";
fabro.postgres.roles.example_app.systemUser = "example";
```

Both accounts must exist first:

```nix
users.groups.example = { };
users.users.example = {
  isSystemUser = true;
  group = "example";
};
users.users.example-migrator = {
  isSystemUser = true;
  group = "example";
};
```

On a switch, `postgresql-setup.service` creates a missing login role with
no password, then applies the declared `connectionLimit` with `ALTER ROLE
... CONNECTION LIMIT` (the declaration defaults to `-1`, which leaves the
cluster default). `pg_hba.conf` and `pg_ident.conf` are regenerated from
the declarations, so the declared system account maps to its role through
peer authentication. The interface has no `password`, `SUPERUSER`,
`CREATEDB`, or `CREATEROLE` field and renders no such clause. A role
removed from the declaration is never dropped.

### Add an extension

```nix
fabro.postgres.databases.example.extensions = [ "vector" ];
```

The values are the SQL extension names the pinned server package provides:
`pg_textsearch` (preloaded), `vector` (from the `pgvector` package), and
`pg_uuidv7`. On a switch, `postgres-bootstrap.service` connects to the
database and runs `CREATE EXTENSION IF NOT EXISTS "<name>"`. It never
upgrades or drops an installed extension; an already-installed extension
keeps its version.

### Add a grant

```nix
fabro.postgres.grants = [
  {
    database = "example";
    role = "example_app";
    privileges = [ "CONNECT" ];
    on = "database";
  }
  {
    database = "example";
    role = "example_app";
    privileges = [ "USAGE" ];
    on = "schema";
  }
  {
    database = "example";
    role = "example_app";
    privileges = [ "SELECT" "INSERT" "UPDATE" "DELETE" ];
    on = "all-tables";
  }
  {
    database = "example";
    role = "example_app";
    privileges = [ "USAGE" "SELECT" ];
    on = "all-sequences";
  }
];
```

Each `on` admits only its own privilege set: `database` takes `CONNECT`,
`schema` takes `USAGE`, `all-tables` takes `SELECT`/`INSERT`/`UPDATE`/
`DELETE`, and `all-sequences` takes `USAGE`/`SELECT`. Database-level
grants, the `schema` USAGE grant, and the owner's default privileges are
applied by `postgres-bootstrap.service`; `postgres-grants.service`
re-applies the schema grant and applies the `all-tables` and
`all-sequences` grants after the schema-initialization units, because the
tables and views do not exist before then. A switch that changes a grant
declaration re-applies the grants and never revokes a privilege that was
removed from the declaration; to take a privilege away, run the `REVOKE`
manually as `postgres`.

### Add a schema-init unit

```nix
fabro.postgres.schemaInitUnits = [ "example-db-init.service" ];
```

The declared unit must already exist in the same configuration. The
interface only adds ordering: `postgres-bootstrap.service` runs before
every entry and `postgres-grants.service` requires and runs after every
entry. A workload's own unit must also name the init unit in its
`requires`/`after` (as `litellm.service` does); the declaration does not
add that dependency. A switch that changes the declaration restarts the
affected provisioning units in that order; a change confined to the init
unit does not restart `postgres-grants.service`. A manual restart of an
init unit also does not re-run the grant unit.

### What a switch does

A switch (`lima-vm-deploy` from the mac, or
`sudo nixos-rebuild switch --flake .#fabro-vm` on the guest) rebuilds the
guest and restarts the units whose definitions changed:

1. `postgresql.service` uses the regenerated `pg_hba.conf` and
   `pg_ident.conf`, so only the declared roles can connect, and only over
   the socket.
2. `postgresql-setup.service` creates any missing declared database or
   role and applies a declared `connectionLimit` when it is not `-1`. It
   never drops an existing database or role.
3. `postgres-bootstrap.service` applies the generated bootstrap SQL:
   guarded ownership, database-level revocation and `CONNECT`, extensions,
   the `public` schema posture, and the owner's default privileges.
4. `litellm-db-init.service` runs `prisma db push --skip-generate` as
   `litellm_migrator`, then applies the eight LiteLLM views. It runs on
   boot and whenever its unit or store paths change; it never passes
   `--accept-data-loss`.
5. `postgres-grants.service` re-applies the table, sequence, and view
   grants for the declared application roles.
6. `litellm.service` restarts when its package or configuration changes,
   after the database units above have succeeded.

A failed bootstrap or grant unit leaves its successors and the proxy
down; its journal names the failing declaration through the
`fabro.postgres: ...` markers and the failing SQL statement. A failed init
unit leaves the grant unit and the proxy down, and prints either the
Prisma diff or the failing view statement.

## Inspecting schema initialization

`litellm-db-init.service` is a single oneshot that applies LiteLLM's
pinned Prisma schema and then the repository's eight views. The installed
`litellm-db-init` script accepts `--help`, which prints the schema and
view file it uses.

```sh
sudo systemctl status litellm-db-init.service
```

**Expected observation:** `Active: active (exited)` with a `status=0/SUCCESS`
exit line. A `failed` unit means the Prisma push or the view SQL failed;
the unit output below names the failing step.

```sh
sudo journalctl -u litellm-db-init.service -n 60 --no-pager
```

**Expected observation:** `litellm-db-init: applying LiteLLM's Prisma
schema`, then either `🚀  Your database is now in sync with your Prisma
schema.` (first run against an empty database) or `The database is already
in sync with the Prisma schema.` (a later or repeated run), then
`litellm-db-init: applying the LiteLLM views` and eight `CREATE VIEW`
lines. A destructive schema change fails the unit and prints the Prisma
diff instead of dropping data.

```sh
sudo -u postgres psql -h /run/postgresql -d litellm -c '\dt'
```

**Expected observation:** 64 tables, every one owned by `litellm_migrator`.
These are the Prisma models of the pinned LiteLLM schema.

```sh
sudo -u postgres psql -h /run/postgresql -d litellm \
  -c "SELECT viewname FROM pg_views WHERE schemaname = 'public' ORDER BY viewname;"
```

**Expected observation:** eight rows, in this order: `DailyTagSpend`,
`Last30dKeysBySpend`, `Last30dModelsBySpend`, `Last30dTopEndUsersSpend`,
`LiteLLM_VerificationTokenView`, `MonthlyGlobalSpend`,
`MonthlyGlobalSpendPerKey`, `MonthlyGlobalSpendPerUserPerKey`. The
verification view contains `project_alias`; the other seven are the spend
reporting views.

The cluster's provisioning units are inspected the same way:

```sh
sudo systemctl status postgresql postgresql-setup postgres-bootstrap postgres-grants
sudo journalctl -u postgres-bootstrap.service | grep 'fabro.postgres:'
sudo journalctl -u postgres-grants.service | grep 'fabro.postgres:'
```

**Expected observation:** `postgresql` is `active (running)`;
`postgresql-setup`, `postgres-bootstrap`, and `postgres-grants` are
`active (exited)` with `status=0/SUCCESS`. The bootstrap journal contains
`fabro.postgres: database litellm` and `fabro.postgres: role
litellm_migrator`; the grant journal contains `fabro.postgres: grant
litellm litellm_app all-tables`, `... all-sequences`, and `... schema`.

A failed or stale init can be retried without manual cleanup:

```sh
sudo systemctl start litellm-db-init.service     # retry a failed unit
sudo systemctl restart litellm-db-init.service   # force an idempotent re-run
```

### LiteLLM's expected `prisma package not found` line

`journalctl -u litellm.service` contains this line once at startup:

```text
Unable to connect to DB. DATABASE_URL found in environment, but prisma package not found.
```

It is expected, not a database failure. The proxy's runtime PATH
deliberately has no `prisma` CLI: the schema-initialization unit owns
`prisma db push`, and the proxy runs the generated Prisma client that is
built into the `litellm-db` package. The line is the CLI-detection branch
observing that absence; the generated client still connects over
`/run/postgresql`, and `litellm.service` reaches `active` only through its
`/health/liveliness` gate. The signals that do indicate a database
problem are a `failed` `litellm.service`, a unit stuck in `activating`
past its start timeout, a Prisma connection error in the same journal, or
a database unit in the smoke below that is not `active`.

## Operator smoke

Run these steps on the guest (`lima-vmctl shell fabro`). Each step states
the observation that makes it pass.

### 1. Unit states

```sh
systemctl is-active postgresql postgresql-setup postgres-bootstrap litellm-db-init postgres-grants litellm
```

**Expected observation:** six lines, each `active` (`postgresql` is
`active (running)`; the oneshots are `active (exited)`). Any `failed`,
`activating`, or `inactive` line is a failure to investigate with
`systemctl status` and the unit's journal.

### 2. Socket-only reachability

```sh
sudo -u postgres psql -h /run/postgresql -d postgres -c 'SELECT 1'
```

**Expected observation:** exit status 0 and one row with value `1`.

```sh
psql -h 127.0.0.1 -p 5432 -d postgres -c 'SELECT 1'
```

**Expected observation:** exit status 2 and, on stderr:

```text
psql: error: connection to server at "127.0.0.1", port 5432 failed: Connection refused
    Is the server running on that host and accepting TCP/IP connections?
```

```sh
ss -ltn | grep -F ':5432'
```

**Expected observation:** no output, and `grep` exits 1. Nothing listens on
TCP port 5432, matching `SHOW listen_addresses` returning an empty
string.

### 3. Required extensions

Create a throwaway database in the running cluster and install the three
extensions there; the `litellm` database itself declares none of them.

```sh
sudo -u postgres psql -h /run/postgresql -d postgres -c 'CREATE DATABASE postgres_smoke'
sudo -u postgres psql -h /run/postgresql -d postgres_smoke \
  -c 'CREATE EXTENSION pg_textsearch; CREATE EXTENSION vector; CREATE EXTENSION pg_uuidv7;'
sudo -u postgres psql -h /run/postgresql -d postgres_smoke -c 'SELECT uuid_generate_v7();'
sudo -u postgres psql -h /run/postgresql -d postgres_smoke \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('pg_textsearch', 'vector', 'pg_uuidv7') ORDER BY extname;"
sudo -u postgres psql -h /run/postgresql -d postgres_smoke -c 'SHOW shared_preload_libraries;'
sudo -u postgres psql -h /run/postgresql -d postgres -c 'DROP DATABASE postgres_smoke'
```

**Expected observation:** three `CREATE EXTENSION` tags with no error; one
UUID whose third group starts with `7` and whose fourth group starts with
`8`, `9`, `a`, or `b` (for example
`0192f3a4-5b6c-7d8e-9f01-23456789abcd`); `pg_textsearch | 1.5.1`,
`pg_uuidv7 | 1.7` (the package is 1.7.0; the extension's SQL version is
`1.7`), and `vector | 0.8.7`; `pg_textsearch` from `SHOW
shared_preload_libraries`; and a final `DROP DATABASE`.

### 4. Role separation and DDL denial

```sh
sudo -u postgres psql -h /run/postgresql -d postgres -c '\du litellm_app'
sudo -u postgres psql -h /run/postgresql -d postgres -c '\du litellm_migrator'
sudo -u postgres psql -h /run/postgresql -d postgres \
  -c "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname IN ('litellm_app', 'litellm_migrator') ORDER BY rolname;"
sudo -u postgres psql -h /run/postgresql -d postgres -c '\l litellm'
```

**Expected observation:** both `\du` listings show an empty Attributes
column (no `Superuser`, `Create DB`, `Create role`, `Replication`, or
`Bypass RLS`); the attribute query returns `f | f | f | t` for both
`litellm_app` and `litellm_migrator`; and `\l litellm` shows the database
owner as `litellm_migrator`.

```sh
sudo -u litellm psql -U litellm_app -h /run/postgresql -d litellm \
  -c 'SELECT count(*) FROM "LiteLLM_VerificationToken";'
```

**Expected observation:** exit status 0 and a count (0 on a fresh
database). The `-U litellm_app` request matches the `local all
litellm_app peer map=fabro-services` rule, and `pg_ident.conf` maps the
`litellm` system account to `litellm_app`; without `-U`, `psql` would
request the role `litellm`, which the final reject rule denies.

```sh
sudo -u litellm psql -U litellm_app -h /run/postgresql -d litellm \
  -c 'CREATE TABLE smoke_should_fail (id int);'
```

**Expected observation:** exit status 1 and:

```text
ERROR:  permission denied for schema public
```

The application role has `USAGE` on `public` and DML on the tables, but no
`CREATE`, so the proxy cannot create, alter, or drop a persistent object.

### 5. Persistence across a `litellm` restart

Export `LITELLM_MASTER_KEY` as `docs/litellm-routing-runbook.md`
("Observing placement") describes; its provisioning details stay in the
design's `## Operator Provisioning` section. Do not paste the key into
the transcript, and do not run these commands with `set -x` or `curl -v`.

Create a virtual key. The response carries the key value twice (`key` and
`token`), so write it to a mode-0600 file instead of printing it:

```bash
umask 077
curl -sS -X POST http://127.0.0.1:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"key_alias":"smoke-persistence"}' > /tmp/litellm-smoke-key.json
KEY=$(sed -nE 's/.*"key"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' /tmp/litellm-smoke-key.json)
test -n "$KEY"
```

**Expected observation:** `test -n "$KEY"` exits 0 (the request returned
`"key_alias":"smoke-persistence"` and an `sk-` value that stays in the
file).

Send one request with that key, then wait for the spend-log row. The
proxy queues spend logs in memory and flushes them from a background
writer (2-second base interval, backing off to 30 seconds), so a count
taken immediately after the request can still be 0, and a restart before
the flush would discard the queued row:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'x-opencode-session: smoke-persistence-0001' \
  -d '{"model":"gpt-6-luna","messages":[{"role":"user","content":"smoke"}]}'
spend_before=0
for attempt in {1..30}; do
  spend_before=$(sudo -u postgres psql -h /run/postgresql -d litellm -tAc 'SELECT count(*) FROM "LiteLLM_SpendLogs";')
  [ "$spend_before" -ge 1 ] && break
  sleep 2
done
test "$spend_before" -ge 1
```

**Expected observation:** `200`, then `test "$spend_before" -ge 1` exits 0
within 60 seconds. Record the count; the post-restart step compares
against it.

Create one database-backed admin UI user (once) and set its password; the
password is typed at the prompt and never appears in this document or in
the command history as a value:

```bash
curl -sS -X POST http://127.0.0.1:4000/user/new \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"smoke-admin","user_email":"smoke-admin@example.invalid","user_role":"proxy_admin","auto_create_key":false}'
read -rsp 'Admin UI password: ' ADMIN_UI_PASSWORD; echo
curl -sS -X POST http://127.0.0.1:4000/user/update \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary "$(printf '{"user_id":"smoke-admin","password":"%s"}' "$ADMIN_UI_PASSWORD")"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4000/login \
  --data-urlencode 'username=smoke-admin@example.invalid' \
  --data-urlencode "password=$ADMIN_UI_PASSWORD"
```

**Expected observation:** `user/new` returns `smoke-admin` with the
`proxy_admin` role and an empty `key`; `user/update` returns the user with
no `password` field; and `/login` returns `303` (the redirect that sets the
UI cookie). Use a password without `"` or `\`, which would break the JSON
body.

Now restart the proxy and check the persisted state:

```bash
sudo systemctl restart litellm.service
sudo systemctl start fabro.service
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/health/liveliness
curl -sS 'http://127.0.0.1:4000/key/list?key_alias=smoke-persistence&return_full_object=true' \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" | grep -o 'smoke-persistence' | head -n1
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'x-opencode-session: smoke-persistence-0002' \
  -d '{"model":"gpt-6-luna","messages":[{"role":"user","content":"smoke"}]}'
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4000/login \
  --data-urlencode 'username=smoke-admin@example.invalid' \
  --data-urlencode "password=$ADMIN_UI_PASSWORD"
sudo -u postgres psql -h /run/postgresql -d litellm \
  -c "SELECT count(*) FROM \"LiteLLM_VerificationToken\" WHERE key_alias = 'smoke-persistence';"
spend_after=0
for attempt in {1..30}; do
  spend_after=$(sudo -u postgres psql -h /run/postgresql -d litellm -tAc 'SELECT count(*) FROM "LiteLLM_SpendLogs";')
  [ "$spend_after" -ge "$((spend_before + 1))" ] && break
  sleep 2
done
test "$spend_after" -ge "$((spend_before + 1))"
rm -f /tmp/litellm-smoke-key.json
```

**Expected observation:** `/health/liveliness` returns `200`; the key list
prints `smoke-persistence`; the request with the same key returns `200`,
so the key is still valid; `/login` returns `303`, so the same admin UI
credentials still authenticate; the verification-token query returns at
least one `smoke-persistence` row; and `test "$spend_after" -ge
"$((spend_before + 1))"` exits 0 within 60 seconds, so the pre-restart
spend row survived and the new request's row landed. Nothing was recreated
by the restart: keys, spend logs, and admin users all live in the
`litellm` database. The last command removes the temporary key file.

`fabro.service` hard-requires the gateway, so it stopped with the restart;
the `systemctl start` above brings it back. After a guest reboot, repeat
step 1 and this step's observations; the same results cover Requirement
6.7's reboot case. The smoke key and admin user are deliberately
persistent; remove them in the admin UI if they should not stay in the
database.

## Credentials

This configuration introduces no database password: peer authentication
over the Unix socket maps the `litellm` and `litellm-migrator` system
accounts to their database roles. The master key (`litellm-master-key`,
rendered from the guest's sops store into the `litellm-env` environment
file) and the ChatGPT OAuth credential
(`/var/lib/litellm/chatgpt/auth.json`) are operator-owned and reused
unchanged. Their source, provisioning command, verification, and owner are
recorded in the design document's `## Operator Provisioning` section; this
runbook neither repeats nor replaces those commands and carries no
credential value.

## Pre-switch validation

`nix flake check` on an `aarch64-linux` host (the guest or a Linux
builder) runs the evaluated guest assertions plus the `postgres-scratch`
and `litellm-db-init` checks. The scratch check proves the socket-only
exposure, the three extensions, and bootstrap idempotence; the init check
proves the Prisma tables, the eight views, the application role's DML
access, its DDL denial, and the second-run no-op. Run it before switching
a change that touches the cluster, the declarations, or the LiteLLM
database wiring.
