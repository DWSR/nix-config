# Research: PostgreSQL 18.6 on the Fabro guest for LiteLLM

This file records the external and repository facts used by `design.md`. Every
fact below was read from the pinned flake input, the pinned LiteLLM package, or
an upstream document; the verification log at the end records the local
experiments that exercised the mechanism.

## 1. PostgreSQL and extension versions

Evaluated from the repository's locked `nixpkgs-unstable` input
(`nix eval .#nixosConfigurations.fabro-vm.pkgs.unstable...`):

| Attribute | Version | SQL extension name | Notes |
|-----------|---------|--------------------|-------|
| `postgresql_18` | 18.6 | — | `psqlSchema` is `"18"`; `services.postgresql.dataDir` default is `/var/lib/postgresql/18` |
| `postgresql_18.pkgs.pg_textsearch` | 1.5.1 | `pg_textsearch` | `pg_textsearch.control`; `relocatable = false`; SQL aborts unless the library is preloaded |
| `postgresql_18.pkgs.pgvector` | 0.8.7 | `vector` | The package is named `pgvector`; the installable extension is `vector` (`vector.control`, `module_pathname = '$libdir/vector'`) |
| `postgresql_18.pkgs.pg_uuidv7` | 1.7.0 | `pg_uuidv7` | `pg_uuidv7.control` (`default_version = 1.7`); `uuid_generate_v7()` is declared in `pg_uuidv7--1.7.sql` |

- `pgvector` 0.8.7 satisfies total-recall's 0.8.6 floor; the stable package set
  has 0.8.2 (`pkgs/servers/sql/postgresql/ext/pgvector.nix` in the stable
  nixpkgs), which is below the floor. This is why the cluster and extensions
  come from `pkgs.unstable`.
- `pg_textsearch--1.5.1.sql` raises
  `pg_textsearch library not loaded. Add pg_textsearch to shared_preload_libraries and restart.`
  when the module is not preloaded.
- `pg_uuidv7--1.7.sql` defines `uuid_generate_v7()` returning `uuid`.

## 2. NixOS `services.postgresql` module behavior

Read from the pinned nixpkgs
`nixos/modules/services/databases/postgresql.nix`:

- `enableTCPIP = false` sets `listen_addresses = "localhost"` (module line
  `listen_addresses = if cfg.enableTCPIP then "*" else "localhost";`). It is
  not an empty listener. Removing TCP requires `lib.mkForce ""` on
  `services.postgresql.settings.listen_addresses`.
- The default `services.postgresql.authentication` is assembled with
  `mkMerge`/`mkAfter` and appends:
  ```
  local all postgres         peer map=postgres
  local all all              peer
  host  all all 127.0.0.1/32 md5
  host  all all ::1/128      md5
  ```
  `lib.mkForce` is required to remove the two `host` rules.
- The default `services.postgresql.identMap` appends
  `postgres postgres postgres`; declaring a map must keep that entry (the
  module uses `mkAfter`).
- `dataDir` defaults to `/var/lib/postgresql/${package.psqlSchema}`.
- `systemd.services.postgresql` sets `RuntimeDirectory = "postgresql"`
  (`/run/postgresql`), runs as `postgres`, and `Restart = "always"`.
- `systemd.services.postgresql-setup` is a `oneshot` that runs as `postgres`
  after `postgresql.service`; it creates each `ensureDatabases` entry with
  `CREATE DATABASE "<name>"` and each `ensureUsers` entry with
  `CREATE USER "<name>"`, then applies `ensureClauses` via `ALTER ROLE`.
  `ensureDatabases`/`ensureUsers` never delete objects.
- `ensureUsers[].ensureClauses` is a freeform attrset; it accepts a
  `password` clause. The repository interface must not expose that field.

## 3. LiteLLM 1.86.0 database path

Read from the pinned `pkgs.litellm` output
(`/nix/store/yk7hy1zlx50msh8dh07xh4jnqzv849lz-python3.13-litellm-1.86.0`)
and nixpkgs `pkgs/development/python-modules/litellm/default.nix`:

- `litellm/proxy/schema.prisma` is shipped; the datasource is
  `url = env("DATABASE_URL")`, the generator is `prisma-client-py`.
- No generated Prisma client is installed. `prisma/__init__.py` raises
  `RuntimeError("The Client hasn't been generated yet...")` when
  `prisma/client.py` is absent, and `litellm/proxy/db/prisma_client.py`
  imports `from prisma import Prisma`.
- `litellm/proxy/proxy_cli.py` only enters the database bootstrap path when
  `DATABASE_URL` is set **and** `subprocess.run(["prisma"])` does not raise
  `FileNotFoundError`. The `pkgs.litellm` wrapper PATH includes
  `python3.13-prisma-0.15.0/bin`, so the Python Prisma CLI is currently
  discoverable.
- With `general_settings.disable_prisma_schema_update` false,
  `PrismaManager.setup_database` runs
  `prisma db push --accept-data-loss --skip-generate` (or `prisma migrate
  deploy` with the extras package) from `litellm/proxy` and retries four
  times. With updates disabled, `proxy_cli.py` runs
  `check_prisma_schema_diff`, which shells out to `prisma migrate diff
  --to-schema-datamodel ./schema.prisma`.
- `should_update_prisma_schema()` reads `DISABLE_SCHEMA_UPDATE` (default
  `"false"`); `DISABLE_SCHEMA_UPDATE=true` disables the update path.
- `litellm/proxy/utils.py:check_view_exists` expects eight views:
  `LiteLLM_VerificationTokenView`, `MonthlyGlobalSpend`,
  `Last30dKeysBySpend`, `Last30dModelsBySpend`, `MonthlyGlobalSpendPerKey`,
  `MonthlyGlobalSpendPerUserPerKey`, `Last30dTopEndUsersSpend`, and
  `DailyTagSpend`. When the count is short and `LiteLLM_SpendLogs` is empty
  (`should_create_missing_views`), it executes `CREATE VIEW` as the connecting
  role. A non-owner application role therefore causes a startup error unless
  the views already exist.
- The view bodies are in `litellm/proxy/db/create_views.py`; the current
  `LiteLLM_VerificationTokenView` body includes `p.project_alias` from
  `LiteLLM_ProjectTable`.
- `pkgs.litellm` is `python3Packages.toPythonApplication` over
  `python3Packages.litellm` with `optional-dependencies.proxy`,
  `extra_proxy`, and `proxy-runtime` merged in; `prisma` is in `extra_proxy`.

## 4. Prisma Python client, CLI, and engines

Read from `python3.13-prisma-0.15.0` and prisma-client-py 0.15.0 upstream:

- `prisma/_config.py` pins `prisma_version = "5.17.0"` and
  `expected_engine_version = "393aa359c9ad4a4bb28630fb5613f9c281cde053"`.
- `prisma/generator/generator.py` copies the base `prisma` package into the
  generator output directory and writes `schema.prisma` there, so a custom
  `output` produces a self-contained `prisma` package.
- `prisma/engine/utils.py` honors `PRISMA_QUERY_ENGINE_BINARY` and otherwise
  looks in `$PWD`, the CLI-provided binary paths, or
  `$HOME/.cache/prisma-python/binaries/...`.
- nixpkgs packages `prisma_6` 6.19.3 and `prisma_7` 7.8.0, but **not** the
  5.17.0 CLI that prisma-client-py 0.15.0 expects.
- prisma-client-py's 0.14.0 release notes state the internal Prisma version
  was updated to 5.17.0, and 0.15.0 retains that pin; the repository was
  archived on 2025-04-15 and has no Prisma 6/7 release. Using the 6.x
  CLI/engine with this client is not supported by upstream.
- The pinned Prisma 5.17.0 artifacts exist:
  - `https://registry.npmjs.org/prisma/-/prisma-5.17.0.tgz`
  - `https://binaries.prisma.sh/all_commits/393aa359c9ad4a4bb28630fb5613f9c281cde053/linux-arm64-openssl-3.0.x/query-engine.gz`
  - `https://binaries.prisma.sh/all_commits/393aa359c9ad4a4bb28630fb5613f9c281cde053/linux-arm64-openssl-3.0.x/schema-engine.gz`
- The downloaded engine binaries are dynamically linked against
  `/lib/ld-linux-aarch64.so.1`; in a Nix build sandbox they need
  `autoPatchelfHook` (or `patchelf --set-interpreter/--set-rpath`) before they
  can execute. The 5.17 CLI itself is a Node program and needs the npm
  dependency closure, not a downloaded engine, when
  `PRISMA_QUERY_ENGINE_BINARY`/`PRISMA_SCHEMA_ENGINE_BINARY` are set.

## 5. Prisma socket connection URL

Prisma's PostgreSQL documentation gives the Unix-socket form:

```
postgresql://user:password@localhost/db?host=/var/run/postgresql/
```

The `host` query parameter is the socket directory; the authority host and port
are still parsed, so the port must be carried in the authority when it is not
5432 (verified locally: `postgresql://postgres@localhost:54329/litellm?host=/tmp/pgtest/run`
connected; `?host=...&port=54329` did not, and Prisma used 5432). On the guest
the port is the default 5432, so
`postgresql://litellm_app@localhost/litellm?host=/run/postgresql` is
unambiguous.

## 6. Verification log (aarch64, pinned flake)

These experiments used the repository's evaluated packages; no guest was
touched.

1. Built `postgresql_18.withPackages (ps: [ ps.pg_textsearch ps.pgvector ps.pg_uuidv7 ])`
   from the pinned unstable input; initialized a scratch cluster with
   `listen_addresses = ''`, `unix_socket_directories = <tmp>/run`,
   `port = 54329`, `shared_preload_libraries = 'pg_textsearch'`.
2. `CREATE EXTENSION pg_textsearch; CREATE EXTENSION vector; CREATE EXTENSION pg_uuidv7;`
   returned three `CREATE EXTENSION` results.
3. `SELECT uuid_generate_v7()` returned
   `01a1e255-174b-71fc-84ba-57fdc96088bc`; `pg_extension` reported
   `pg_textsearch:1.5.1`, `pg_uuidv7:1.7`, `vector:0.8.7`;
   `SHOW shared_preload_libraries` returned `pg_textsearch`.
4. A `psql -h 127.0.0.1 -p 54329` connection failed with `Connection refused`
   while the socket connection succeeded.
5. Installed `prisma@5.17.0` from npm, downloaded the query and schema engines,
   patched their interpreter/RPATH with `patchelf`, and ran
   `prisma generate` on LiteLLM's `schema.prisma` with
   `output = <tmp>/generated`. It printed
   `Generated Prisma Client Python (v0.15.0)` and produced a complete
   `prisma` package.
6. `prisma db push --skip-generate` against the scratch socket created 64
   tables in the `litellm` database; a second run printed
   `The database is already in sync with the Prisma schema.` Two
   `pg_dump --schema-only` runs differ only in pg_dump's per-run random
   `\restrict`/`\unrestrict` guard token, so the check must strip those lines
   before comparing.
7. With the database owned by `litellm_migrator` and
   `ALTER DEFAULT PRIVILEGES FOR ROLE litellm_migrator ...` in place, a view
   created by `litellm_migrator` was selectable by `litellm_app`; the
   application role could `SELECT`/`INSERT` on migrator-owned tables but
   `CREATE TABLE` failed with `permission denied for schema public`.
8. `prisma db push` without `--accept-data-loss` on an empty database succeeds;
   with a populated column, it refuses the drop and prints
   `There might be data loss when applying the changes: ... You are about to
   drop the column ... which still contains 1 non-null values` plus
   `Use the --accept-data-loss flag`. The design therefore omits that flag:
   a change that would drop existing data fails, while dropping an empty
   column (no existing data) is allowed.

## 7. Sources

- Pinned nixpkgs module: `nixos/modules/services/databases/postgresql.nix` in
  the flake's `nixpkgs` input.
- Pinned nixpkgs LiteLLM module:
  `nixos/modules/services/misc/litellm.nix` (DynamicUser, StateDirectory,
  ExecStart shape).
- Pinned LiteLLM package:
  `pkgs/development/python-modules/litellm/default.nix` and
  `pkgs/by-name/li/litellm/package.nix`.
- LiteLLM upstream: `litellm/proxy/proxy_cli.py`,
  `litellm/proxy/db/prisma_client.py`,
  `litellm/proxy/db/check_migration.py`,
  `litellm/proxy/db/create_views.py`, and
  `litellm/proxy/utils.py` in the 1.86.0 package.
- prisma-client-py 0.15.0: `prisma/_config.py`,
  `prisma/generator/generator.py`, `prisma/engine/utils.py`;
  https://github.com/RobertCraigie/prisma-client-py/releases/tag/v0.15.0
  and https://github.com/RobertCraigie/prisma-client-py/releases (archived
  2025-04-15).
- Prisma PostgreSQL documentation, "Socket connections":
  https://www.prisma.io/docs/orm/overview/databases/postgresql
- pgvector: https://github.com/pgvector/pgvector (`vector` extension name).
- PostgreSQL `pg_hba.conf` and peer authentication:
  https://www.postgresql.org/docs/current/auth-pg-hba-conf.html
- PostgreSQL `ALTER DEFAULT PRIVILEGES`:
  https://www.postgresql.org/docs/current/sql-alterdefaultprivileges.html
