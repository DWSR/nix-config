# Implementation Plan

Phase 1 lands the socket-only cluster and the `fabro.postgres` declaration
surface, because every later unit consumes its option values and its generated
SQL. Phase 2 builds the offline Prisma client and the `litellm-db` package the
proxy runs from. Phase 3 declares the `litellm` database, its two roles, the
eight views, and the schema-initialization unit, then switches the proxy onto the
fixed account and that database. Phase 4 adds the evaluated assertions, the two
scratch checks, and the operator runbook; phase 5 runs the whole gate and reads
back the rendered unit graph.

> **Operator preconditions, not tasks**: this spec introduces no new secret and no
> database password. The existing `litellm-master-key` sops template and the
> ChatGPT OAuth credential stay operator-owned exactly as the design's
> `## Operator Provisioning` section records. The tasks below only preserve their
> wiring: they never mint, read, rotate, or write a credential value.

- [ ] 1. Socket-only PostgreSQL 18.6 cluster and the `fabro.postgres` interface

- [x] 1.1 Add `configurations/fabro-vm/postgres.nix` with the declaration surface and its assertions
  - Import it from `configurations/fabro-vm/default.nix` and declare `enable`, `package` (default `pkgs.unstable.postgresql_18`), read-only `dataDir` (`/var/lib/postgresql/18`) and `socketDir` (`/run/postgresql`), `roles` (`systemUser` defaulting to the role name, `connectionLimit` default `-1`), `databases` (`owner`, `extensions`), `grants` (`database`, `role`, `privileges`, `on` of `database`/`schema`/`all-tables`/`all-sequences`), and `schemaInitUnits`
  - Omit `password`, `superuser`, `createdb`, and `createrole` from every option; fail evaluation when a name breaks `[a-z_][a-z0-9_]*`, a database or role is `postgres`, a database owner or grant target is not a declared role, a `systemUser` is absent from `users.users`, or a grant pairs an `on` with a privilege outside its allowed set
  - Completed when `nix eval .#nixosConfigurations.fabro-vm.config.fabro.postgres` shows the empty declaration sets with those defaults, and a temporary declaration with an undeclared owner or a `postgres` role fails evaluation naming the option path
  - _Requirements: 1.1, 4.1, 4.10, 4.11, 5.3, 5.4, 9.1, 9.4, 9.5_

- [x] 1.2 Run one PostgreSQL 18.6 server on the Unix socket with the three extensions
  - Set `services.postgresql = { enable = cfg.enable; package = cfg.package; extensions = ps: [ ps.pg_textsearch ps.pgvector ps.pg_uuidv7 ]; }`, `settings.shared_preload_libraries = "pg_textsearch"`, `settings.unix_socket_directories = cfg.socketDir`, and `settings.port = 5432`
  - Force `settings.listen_addresses = lib.mkForce ""` because the module's `enableTCPIP = false` still writes `localhost`; add no `allowedTCPPorts` entry, no `tailscale serve` line, and no second server, cluster, major version, or data directory
  - Set `fabro.postgres.enable = true` in `configurations/fabro-vm/default.nix`; the module's `postgres` account owns the server and `/var/lib/postgresql/18`, so a switch preserves databases, roles, and rows and nothing in this module drops an object, and a start failure surfaces as a failed/restarting unit with the server error in its journal
  - Completed when the rendered guest shows one enabled cluster at 18.6 with `listen_addresses = ""`, `/var/lib/postgresql/18`, the three extension packages (`pgvector` at or above 0.8.6), `pg_textsearch` preloaded, and no 5432 firewall or Serve entry
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8, 1.9, 2.1, 2.2, 2.5, 2.6, 3.1, 3.2, 3.5, 3.6_

- [x] 1.3 Force socket-only authentication and map each declared role to its system user
  - Build `services.postgresql.authentication` with `lib.mkForce` from `fabro.postgres.roles`: the module's `local all postgres peer map=postgres` line plus one `local all <role> peer map=fabro-services` line per declared role and a final `local all all reject`; emit no `host`, `md5`, `scram`, or `trust` line
  - Add `services.postgresql.identMap` with `lib.mkAfter` a `fabro-services <systemUser> <role>` entry per role, keeping the module's `postgres postgres postgres` entry so the superuser mapping survives
  - Drive both files from the same declaration set, and add no hand-written `pg_hba`/`pg_ident` copy, password, or network allowance
  - Completed when the rendered `pg_hba.conf` holds only `local` lines ending in the reject rule (the module's two default `host ... md5` lines are gone) and `pg_ident.conf` maps every declared system user to its role
  - _Requirements: 2.3, 2.4, 5.9, 5.10, 9.1, 9.2, 9.3_

- [ ] 2. Declarative provisioning adapter

- [x] 2.1 Project the declarations into `ensureDatabases` and `ensureUsers`
  - Set `services.postgresql.ensureDatabases = lib.attrNames cfg.databases` and `ensureUsers` from `cfg.roles` as `{ name = <role>; ensureClauses.connection_limit = <n>; }` only when `connectionLimit != -1`, never a `password` clause
  - Keep both lists derived only from `fabro.postgres`, so no second source creates a workload database or role and no caller can add one through the module's freeform clauses
  - Completed when adding `databases.<name>` changes exactly the `postgresql-setup` inputs, and `nix eval` shows the declared names in both lists with no `password` key anywhere
  - _Requirements: 4.1, 4.2, 4.3, 4.10, 4.11, 9.1_

- [x] 2.2 Generate the bootstrap SQL and the `postgres-bootstrap` unit
  - Emit one `psql -f` file with a `\echo 'fabro.postgres: database <name>'` or `role <name>` marker before each block: guarded `ALTER DATABASE "<db>" OWNER TO "<owner>"`, `\connect "<db>"` with `CREATE EXTENSION IF NOT EXISTS "<ext>"`, `REVOKE ALL ON DATABASE ... FROM PUBLIC` plus the declared `CONNECT`, `REVOKE CREATE` on the database and on schema `public`, and `ALTER DEFAULT PRIVILEGES FOR ROLE "<owner>"` so the migration role's tables and sequences reach the declared roles
  - Add `systemd.services.postgres-bootstrap` as a `oneshot` with `RemainAfterExit`, `User = "postgres"`, `requires`/`after` `postgresql.service` and `postgresql-setup.service`, `before = cfg.schemaInitUnits`, `wantedBy = [ "multi-user.target" ]`, `PGHOST`/`PGPORT`, and `${config.services.postgresql.finalPackage}/bin/psql -v ON_ERROR_STOP=1` so client and server versions match
  - Keep every statement catalog-conditional or naturally idempotent, expose the generated file from the module (the design's `bootstrapSqlFile`) so a check runs the identical text, and let the `\echo` marker plus the failing statement reach the journal
  - Completed when the file applies twice to a scratch cluster with no error and no catalog change, and the unit is enabled and ordered ahead of every `schemaInitUnits` entry
  - _Requirements: 1.5, 1.6, 4.4, 4.6, 4.7, 4.8, 4.9, 4.11, 5.11, 9.1_

- [ ] 2.3 Generate the object-grant SQL and the `postgres-grants` unit
  - Emit one `psql -f` file with `\connect "<db>"` per database: `GRANT USAGE ON SCHEMA public`, `GRANT <privileges> ON ALL TABLES IN SCHEMA public`, and `GRANT <privileges> ON ALL SEQUENCES IN SCHEMA public` for each declared grant, covering the migration role's tables and the pre-created views
  - Add `systemd.services.postgres-grants` as a `oneshot` with `RemainAfterExit`, `User = "postgres"`, `requires`/`after` `postgres-bootstrap.service` and every `cfg.schemaInitUnits` entry, `wantedBy = [ "multi-user.target" ]`, and the same `finalPackage` client; grant no `CREATE` on the database or `public` and no `SUPERUSER`/`CREATEDB`/`CREATEROLE` class privilege to an application role
  - Keep the file idempotent and expose it from the module (the design's `objectGrantsSqlFile`); a failed statement must leave the unit failed with the declaration named by `psql -v ON_ERROR_STOP=1`
  - Completed when a scratch database with a migrator-owned table, sequence, and view ends with exactly the declared application privileges, a second run changes no ACL, and the unit is ordered after the schema-init units
  - _Requirements: 4.5, 4.6, 4.7, 4.8, 4.9, 5.4, 5.6, 5.7, 5.8, 5.11, 9.1_

- [ ] 3. Offline LiteLLM database package

- [ ] 3.1 (P) Add the pinned Prisma 5.17.0 CLI and the patched query and schema engines
  - Create `overlays/litellm-db.nix` with `litellm-prisma-engines` fetching the 5.17.0 `query-engine` and `schema-engine` for `linux-arm64-openssl-3.0.x` from commit `393aa359c9ad4a4bb28630fb5613f9c281cde053`, applying `autoPatchelfHook` with glibc/gcc/openssl, and recording `passthru.engineCommit`
  - Add the `prisma@5.17.0` npm closure under `overlays/litellm-prisma/` (the design's `package-lock.json` plus the `package.json` it locks) and `litellm-prisma-cli` from `final.importNpmLock` with `NPM_CONFIG_IGNORE_SCRIPTS=1` and a wrapper exporting `PRISMA_SCHEMA_ENGINE_BINARY` and `PRISMA_QUERY_ENGINE_BINARY`; download no engine inside the CLI derivation
  - Register the overlay in `overlays/default.nix` (`custom-packages`) and leave the pinned package set unchanged: no `prisma_6`/`prisma_7` substitution and no runtime fetch
  - Completed when `nix build .#litellm-prisma-cli` reports 5.17.0, both engine binaries print a version inside the sandbox, and the overlay contains only the npm closure plus the two fixed-output engine URLs
  - _Requirements: 7.4, 7.12_
  - _Boundary: overlays/litellm-db.nix, overlays/litellm-prisma/package-lock.json_

- [ ] 3.2 Generate the Prisma client for LiteLLM's schema as `litellm-prisma-client`
  - Extend `overlays/litellm-db.nix` with `litellm-prisma-client`: the pinned `python3Packages.prisma` plus a `postInstall` that copies `litellm/proxy/schema.prisma` from the pinned LiteLLM package, sets the generator `output` to a temporary directory, runs `${litellm-prisma-cli}/bin/prisma generate`, replaces the installed `prisma` package with the generated one, and only then removes `bin/prisma` and `bin/prisma-client-py`
  - Keep the base package's Python dependencies and add no new runtime dependency list; the generated client and the `schema.prisma` the init step pushes must come from the same closure
  - Completed when `python -c 'from prisma import Prisma'` succeeds in the package, generation ran during the build, and the closure exposes no `prisma` executable
  - _Requirements: 6.12, 7.12_
  - _Depends: 3.1_

- [ ] 3.3 Assemble the `litellm-db` proxy package with its `passthru` contract
  - Add `litellm-db` as the same `toPythonApplication`/proxy-dependency merge shape as `pkgs.litellm` with `prisma` removed and `litellm-prisma-client` added, keeping `pname = "litellm"` and `version = "1.86.0"`; expose `passthru.schemaPath`, `passthru.prismaClient`, `passthru.prismaVersion`, and `passthru.tests.prismaClient`
  - Add the attribute to the existing `custom-packages` overlay entry; add no second LiteLLM package, no Prisma CLI on the proxy's PATH, and no generate or download at run time
  - Completed when `nix build .#litellm-db` succeeds, `passthru.tests.prismaClient` imports `prisma.Prisma` and LiteLLM's `prisma_client` without connecting, and `litellm --version` reports 1.86.0
  - _Requirements: 6.12, 7.12_
  - _Depends: 3.2_

- [ ] 4. LiteLLM database wiring

- [ ] 4.1 (P) Add the fixed `litellm` and `litellm-migrator` system accounts
  - Declare `users.groups` and `users.users` entries `litellm` and `litellm-migrator` as system accounts in `configurations/fabro-vm/litellm-db.nix`, each in its matching group; add no unit in this task
  - Leave the Lima cidata account, `users.mutableUsers`, and the existing `svc:fabro`/`svc:litellm`/`svc:opencode` Serve lines untouched, and declare no `DynamicUser` and no privileged supplementary group
  - Completed when the guest evaluation lists both accounts as system users with their groups and no workload unit runs as `postgres`
  - _Requirements: 5.1, 5.2, 5.9, 9.2_
  - _Boundary: configurations/fabro-vm/litellm-db.nix (users only)_

- [ ] 4.2 (P) Transcribe the eight LiteLLM views into `configurations/fabro-vm/postgres/litellm-views.sql`
  - Copy the pinned `litellm/proxy/db/create_views.py` bodies as `CREATE OR REPLACE VIEW` statements for `LiteLLM_VerificationTokenView` (including `p.project_alias`), `MonthlyGlobalSpend`, `Last30dKeysBySpend`, `Last30dModelsBySpend`, `MonthlyGlobalSpendPerKey`, `MonthlyGlobalSpendPerUserPerKey`, `Last30dTopEndUsersSpend`, and `DailyTagSpend`
  - Keep the file pure SQL with no owner, grant, or cluster-admin statement: the migration role creates the views and `postgres-grants` grants them
  - Completed when the file defines exactly those eight names and `psql -f` applies it twice without error on a database owned by the migration role
  - _Requirements: 5.6, 5.7, 7.4_
  - _Boundary: configurations/fabro-vm/postgres/litellm-views.sql_

- [ ] 4.3 Declare the `litellm` database, both roles, the grants, and the schema-init unit
  - In `configurations/fabro-vm/litellm-db.nix` set `fabro.postgres.databases.litellm.owner = "litellm_migrator"`, roles `litellm_migrator` (`systemUser = "litellm-migrator"`) and `litellm_app` (`systemUser = "litellm"`), and grants giving `litellm_app` database `CONNECT`, schema `USAGE`, and `all-tables`/`all-sequences` privileges
  - Set `fabro.postgres.schemaInitUnits = [ "litellm-db-init.service" ]` and declare no `SUPERUSER`/`CREATEDB`/`CREATEROLE`, no `CREATE` on the database or `public`, and no privilege reaching a future workload's database
  - Import `./litellm-db.nix` from `configurations/fabro-vm/default.nix`
  - Completed when evaluation shows the `litellm` database owned by `litellm_migrator`, two distinct roles with their ident maps and grant sets, and the init unit in `schemaInitUnits`
  - _Requirements: 4.1, 5.3, 5.4, 5.5, 5.7, 5.11, 6.1, 7.2_
  - _Depends: 1.1, 4.1_

- [ ] 4.4 Add the `litellm-db-init` script and schema-initialization unit
  - Write the step as one `writeShellApplication` that runs `${pkgs.litellm-prisma-cli}/bin/prisma db push --skip-generate --schema ${pkgs.litellm-db.passthru.schemaPath}` and then `${config.services.postgresql.finalPackage}/bin/psql -v ON_ERROR_STOP=1 -f ${./postgres/litellm-views.sql}`; never pass `--accept-data-loss` and never generate a client
  - Add `systemd.services.litellm-db-init` as a `oneshot` with `RemainAfterExit`, `User`/`Group` `litellm-migrator`, `requires`/`after` `postgres-bootstrap.service`, `before = [ "postgres-grants.service" ]`, and the design's environment matrix (`DATABASE_URL=postgresql://litellm_migrator@localhost/litellm?host=/run/postgresql`, `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE`, `HOME=/tmp`, `CHECKPOINT_DISABLE`, `PRISMA_HIDE_UPDATE_MESSAGE`, both `PRISMA_*` engine variables, `PRISMA_CLI_QUERY_ENGINE_TYPE=binary`)
  - Keep the script importable by the `litellm-db-init` check and make any Prisma or `psql` failure fail the unit, printing the destructive diff or the failing statement
  - Completed when a second run on an initialized database reports the schema in sync and re-applies the views, a destructive fixture change fails the unit without dropping data, and the script's `--help` names the schema and view file paths
  - _Requirements: 4.9, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 9.2, 9.3_
  - _Depends: 2.2, 3.3, 4.2, 4.3_

- [ ] 4.5 Run `litellm.service` as the fixed user against the socket database
  - Set `services.litellm.package = pkgs.litellm-db` and add `DATABASE_URL = "postgresql://litellm_app@localhost/litellm?host=/run/postgresql"`, `DISABLE_SCHEMA_UPDATE = "true"`, and `PRISMA_QUERY_ENGINE_BINARY` to `services.litellm.environment`; keep `PYTHONPATH`, `HOME`, `CHATGPT_TOKEN_DIR`, the sops `environmentFile`, `model_list`, and `router_settings` unchanged
  - Force `User`/`Group` `litellm`, `DynamicUser = false`, and `PrivateUsers = false` on `systemd.services.litellm`, and add `requires`/`after` for `litellm-db-init.service`, `postgres-grants.service`, `postgresql.service`, and `postgresql-setup.service`
  - Add no `prisma db push` to the proxy unit, no schema-update flag, and no password in any rendered environment or unit file
  - Completed when evaluation shows the proxy as `litellm` with `DynamicUser=false`, the socket `DATABASE_URL` without a password, schema updates disabled, and both database units required
  - _Requirements: 1.6, 5.1, 5.9, 6.2, 6.3, 6.10, 6.12, 6.13, 7.7, 7.9, 7.10, 7.11, 9.2, 9.3_
  - _Depends: 4.3, 4.4_

- [ ] 4.6 Install `litellm-db` on the guest and re-own the ChatGPT credential directory
  - Replace `litellm` with `pkgs.litellm-db` in `configurations/fabro-vm/default.nix`'s `environment.systemPackages`, and change only the `DynamicUser` comment in `configurations/fabro-vm/litellm.nix`
  - Add `systemd.tmpfiles.rules` `d` and `Z` entries for `${config.services.litellm.stateDir}/chatgpt` as `0700 litellm litellm` so the existing credential stays readable after the dynamic-account removal; leave the rest of the state directory to the module's `StateDirectory`, keep the login wrapper's `chown --reference`, and correct only its ownership comment
  - Add no credential read or write, no state-directory move, and no unit beyond the tmpfiles rules
  - Completed when the guest installs `litellm-db` instead of `litellm`, renders both tmpfiles rules for the fixed user, and `model_list`/`router_settings`/`environmentFile` render byte-identically to the current ones
  - _Requirements: 6.8, 6.9, 6.11_
  - _Depends: 3.3, 4.5_

- [ ] 5. Evaluated and runtime verification

- [ ] 5.1 Assert the cluster, exposure, extension, and declaration invariants in `fabro-vm-guest-eval`
  - Add one `assertMsg` per invariant to the `fabro-vm-guest-eval` `guestReport` in `flake.nix`: one enabled cluster at 18.6 with `/var/lib/postgresql/18` and no second server unit, `settings.listen_addresses == ""`, every `authentication` line starting with `local`, no `host`/`md5`/`scram` rule, and no 5432 `allowedTCPPorts` entry or PostgreSQL Serve line
  - Assert the three extension packages in `finalPackage.installedExtensions` (`pg_textsearch`, `pgvector`, `pg_uuidv7`), the `pgvector` version floor, `pg_textsearch` in `shared_preload_libraries`, `ensureDatabases`/`ensureUsers` matching the `fabro.postgres` names, no `superuser`/`createdb`/`createrole` clause, no declared password, and the three existing `svc:*` Serve lines unchanged
  - Keep the check pure evaluation (the report stays a string in a trivial `runCommand`, no guest package built) and name the offending option, unit, role, or extension in every message
  - Completed when each assertion fails for a deliberately mutated configuration and the check passes on a host without a Linux builder
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.7, 1.8, 2.2, 2.4, 2.6, 2.7, 3.1, 3.2, 3.5, 4.1, 4.10, 4.11, 5.2, 5.3, 5.4, 8.1, 8.2, 8.3, 8.4, 8.5, 8.16, 9.1, 9.4, 9.5_
  - _Depends: 1.2, 1.3, 2.1_

- [ ] 5.2 Assert the LiteLLM database, package, and unit-ordering invariants
  - Extend the same check with the `litellm` database, the two distinct roles, their grant sets, `services.litellm.package` being `litellm-db` with the generated client, `DATABASE_URL` containing `host=/run/postgresql` and no password, `DISABLE_SCHEMA_UPDATE = "true"`, and `PRISMA_QUERY_ENGINE_BINARY` set
  - Assert `litellm.service` runs as `litellm` with `DynamicUser=false` and requires `litellm-db-init.service` and `postgres-grants.service`, that `postgres-bootstrap`, `postgres-grants`, and `litellm-db-init` exist with their declared users and ordering, and that the ChatGPT tmpfiles rule names the fixed user
  - Completed when a missing init dependency, a schema update left enabled, a shared migration/application role, or a dynamic user fails the check with a message naming that element
  - _Requirements: 5.1, 5.5, 6.2, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 7.9, 7.10, 7.11, 7.12, 8.6, 8.7, 8.8, 8.9_
  - _Depends: 4.5, 4.6, 5.1_

- [ ] 5.3 Add the `postgres-scratch` aarch64-linux check
  - Add `tests/postgres-scratch/{default.nix,cluster.sh,run.sh}`: start the pinned PostgreSQL 18.6 with the three extensions, `listen_addresses = ''`, a temporary socket directory, a non-default port, and `shared_preload_libraries = 'pg_textsearch'`
  - Create `scratch`, install `pg_textsearch`, `vector`, and `pg_uuidv7`, assert `uuid_generate_v7()` returns a v7 UUID and the `vector` `extversion` is at least 0.8.6, connect over the socket, and assert a `127.0.0.1:<port>` connection is refused
  - Create the fixture databases and roles, take the guest's generated bootstrap and grant SQL from `self.nixosConfigurations.fabro-vm`, apply both twice, and compare `pg_dump --schema-only` output after stripping pg_dump's per-run `\restrict`/`\unrestrict` lines
  - Register `postgres-scratch` in `flake.nix` under `optionalAttrs (system == "aarch64-linux")`, print `postgres-scratch: <step>` per step, and name the failing step or declaration
  - Completed when the check builds green on a Linux builder and fails when an extension leaves the package set or the bootstrap stops being idempotent
  - _Requirements: 2.8, 3.3, 3.4, 3.6, 4.6, 4.7, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15_
  - _Depends: 1.2, 2.2, 2.3_

- [ ] 5.4 Add the `litellm-db-init` aarch64-linux check
  - Add `tests/litellm-db-init/{default.nix,run.sh}`: start the same scratch cluster, create the `litellm` database and both roles, apply the guest's generated bootstrap and grant SQL, and run the installed `litellm-db-init` script twice
  - Assert the first run creates the Prisma tables and the eight views, the second run succeeds with a normalized `pg_dump --schema-only` equal to the first, and `LiteLLM_VerificationTokenView` contains `project_alias`
  - Assert `litellm_app` can `SELECT`/`INSERT` on a migrator-owned table and a view, that `CREATE TABLE` fails with `permission denied for schema public`, and that a destructive fixture schema fails the script without touching the database
  - Register `litellm-db-init` in `flake.nix` under `optionalAttrs (system == "aarch64-linux")` and name the failing table, view, role, or step
  - Completed when the check builds green and fails when a view is removed, the application role gains DDL, or `--accept-data-loss` is added
  - _Requirements: 5.6, 5.7, 5.8, 5.9, 5.10, 7.4, 7.5, 7.8, 7.12, 8.15_
  - _Depends: 4.2, 4.3, 4.4_

- [ ] 5.5 (P) Write `docs/postgres-litellm-runbook.md`
  - Record the data directory, socket directory, LiteLLM state directory, and the single `fabro.postgres` declaration site, with how to add a database, role, extension, grant, or schema-init unit and what a switch does to each
  - Document how to inspect the schema-initialization result (`systemctl status`/`journalctl -u litellm-db-init`, `psql -h /run/postgresql -d litellm -c '\dt'`, `SELECT viewname FROM pg_views WHERE schemaname = 'public'`) and name LiteLLM's expected `prisma package not found` line so an operator does not read it as a database failure
  - Write the five smoke steps with the expected observation for each: unit states, socket-only reachability plus a refused TCP probe and no `ss -ltn` 5432 listener, the three extensions with `uuid_generate_v7()`, both roles' attributes with the application role's DDL denial, and key/spend/admin-login persistence across a `litellm` restart
  - Point at the design's `## Operator Provisioning` section for the master key and ChatGPT credential instead of any provisioning command, and carry no literal credential
  - Completed when every step states its expected observation and the document names the three paths and the declaration workflow
  - _Requirements: 6.4, 6.5, 6.6, 6.7, 8.17, 8.18_
  - _Boundary: docs/postgres-litellm-runbook.md_

- [ ] 6. Run the full verification set and read back the rendered unit graph
  - Build `postgres-scratch` and `litellm-db-init`, run `nix flake check`, and evaluate `nixosConfigurations.fabro-vm` and `fabro-vm-guest-eval` in one pass
  - Read the rendered guest to confirm `postgresql -> postgresql-setup -> postgres-bootstrap -> litellm-db-init -> postgres-grants -> litellm`, that only the two provisioning oneshots run as `postgres`, and that `fabro.service` still requires `litellm.service`
  - Confirm no PostgreSQL password, hash, or credential appears in `configurations/`, `overlays/`, the rendered units, or the sops templates, and that the three existing `svc:*` Serve lines are byte-identical
  - Completed when the full check set passes and the rendered chain, users, and credential-free environment match the design
  - _Requirements: 1.6, 4.9, 5.2, 6.13, 7.9, 7.10, 8.1, 8.16, 9.1, 9.3_
  - _Depends: 5.1, 5.2, 5.3, 5.4_
