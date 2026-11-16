# Brief: postgres-cluster-on-the-fabro-host-for-litellm-a

## Problem

> As an agentic developer, I want to run a Postgres cluster on the Fabro host so that I can store state for workloads such as iii and LiteLLM to enable additional functionality.
>
> The Postgres cluster must:
>
> * be on the latest in-support version compatible with both LiteLLM and DWSR/total-recall
> * only exposed via UDS, not TCP, etc.
> * have all extensions required to support DWSR/total-recall already installed
> * be installed via the nix configuration
> * be run with a dedicated user

LiteLLM currently runs without a database, so virtual keys, spend logs, and admin UI login state are not persisted. iii/total-recall has no shared Postgres for session and memory state, and the approved total-recall spec would add a second, loopback-TCP cluster with a different major version. The operator gets neither cross-workload persistence nor one database posture to secure.

## Current State

- `nixosConfigurations.fabro-vm` composes `configurations/fabro-vm/` (fabro, LiteLLM, OpenCode, API bridge, sandbox, Tailscale); no module enables `services.postgresql`, and no PostgreSQL code exists outside `.kiro/specs/`.
- `configurations/fabro-vm/litellm.nix:146` enables `services.litellm` on `127.0.0.1:4000` with the sops master key, but sets no `DATABASE_URL`. `pkgs.litellm` 1.86.0 ships `litellm/proxy/schema.prisma` and the Prisma Python library, but no generated Prisma client; `litellm/proxy/proxy_cli.py` runs `prisma db push` only when a `prisma` executable is on `PATH`, and the module's unit does not provide one.
- `pkgs.unstable.postgresql_18` is 18.6 with `pg_textsearch` 1.5.1, `pgvector` 0.8.7, and `pg_uuidv7` 1.7.0. Stable 26.05 has `pgvector` 0.8.2, below total-recall's 0.8.6 floor. `postgresql_19` is 19rc1, not a supported release.
- `install-total-recall-on-fabro-vm` is approved but unimplemented. Its design (C2) and tasks (3.1-3.4) declare PostgreSQL 17 with loopback TCP, the three extensions, a `memory` database, and four roles inside `configurations/fabro-vm/total-recall.nix`.
- `flake.nix:2437` holds the `fabro-vm-guest-eval` assertions; none cover a database. The guest sops store and templates live in `configurations/fabro-vm/default.nix`; no database secret is declared.

## Desired Outcome

- `nixos-rebuild switch` on the guest runs one PostgreSQL 18.6 cluster from `pkgs.unstable`, data under `/var/lib/postgresql/18`, reachable only at the `/run/postgresql` Unix socket. No TCP listener, no firewall opening, no Tailscale Serve entry, and no `host` authentication rule exists.
- The server package provides `pg_textsearch` (preloaded), `pgvector`, and `pg_uuidv7`; `CREATE EXTENSION` succeeds for all three in a scratch database, and `uuid_generate_v7()` resolves.
- `fabro.postgres` declares databases, roles, extensions, and grants. LiteLLM gets a `litellm` database with separate migration and application roles; total-recall declares its `memory` database and four roles through the same option.
- The server runs as the fixed `postgres` system user; LiteLLM runs as a fixed `litellm` system user; no application role holds `SUPERUSER`/`CREATEDB`/`CREATEROLE`, and no workload logs in as `postgres`.
- LiteLLM connects over the socket with a generated Prisma client, persists virtual keys, spend logs, and UI login state across restarts, and keeps its current model catalog, routing, and master-key behavior.
- `litellm.service` starts only after the schema-initialization unit succeeds; a failed initialization fails the proxy start instead of leaving a half-schema database.
- `nix flake check` fails if TCP is enabled, a `host` auth rule exists, a required extension is missing, a workload uses the superuser, or the proxy starts with schema updates enabled.

## Approach

- Add `configurations/fabro-vm/postgres.nix`, imported from `configurations/fabro-vm/default.nix`, using `services.postgresql` with `package = pkgs.unstable.postgresql_18` and `extensions = ps: [ ps.pg_textsearch ps.pgvector ps.pg_uuidv7 ]`. Set `shared_preload_libraries = [ "pg_textsearch" ]`.
- Force `settings.listen_addresses = ""`; the module's `enableTCPIP = false` still sets `localhost`, so the explicit override is the only way to remove TCP. Force `authentication` to `local` rules only and add `pg_ident` maps for the service accounts.
- Run the server as the module's `postgres` account. Replace LiteLLM's `DynamicUser` with a fixed `litellm` system user, because peer authentication and state ownership must be deterministic; total-recall keeps its `total-recall` account. No database password is needed.
- Expose a `fabro.postgres` option that projects `databases`, `roles`, `extensions`, and `grants` into `ensureDatabases`, `ensureUsers`, an idempotent bootstrap unit, and eval assertions. Instantiate `litellm` here; the total-recall spec instantiates `memory` when it lands.
- Add a repo-owned LiteLLM package variant that generates the Prisma client for `litellm/proxy/schema.prisma` at build time and puts it on the proxy's `PYTHONPATH`. Add `litellm-db-init`, a oneshot that runs `prisma db push --skip-generate` as the migration role; run `litellm.service` as the application role with `DATABASE_URL=postgresql://litellm@localhost/litellm?host=/run/postgresql` and `DISABLE_SCHEMA_UPDATE=true`, ordered `after`/`requires` the init unit.
- Add `fabro-vm-guest-eval` assertions plus a scratch-cluster check that starts PostgreSQL 18.6, creates the three extensions, connects over the socket, asserts no TCP listener accepts a connection, and asserts a second bootstrap run changes no object.

Rejected: the total-recall spec's own PostgreSQL 17 with loopback TCP (two servers and a TCP exposure); letting LiteLLM run `prisma db push --accept-data-loss` on every proxy start (schema mutation and DDL in the application role); and a loopback TCP fallback (the issue requires UDS only).

## Scope

- **In**: PostgreSQL 18.6 server and data directory; extension packages and `pg_textsearch` preload; UDS-only listener and local authentication; the `fabro.postgres` provisioning interface; the `litellm` database, migration/application roles, grants, Prisma client packaging, schema-init unit, `DATABASE_URL`, and service ordering; guest eval assertions and the scratch-cluster check; an operator smoke/runbook.
- **Out**: total-recall's `memory` schema, migrations, grants, iii runtime, workers, adapters, Serve entry, and client wiring; LiteLLM routing, model catalog, virtual-key policy, budgets, and spend-log retention; backups, restore, PITR, replication, HA, monitoring, and tuning; TCP or tailnet access to PostgreSQL; the macOS launchd LiteLLM module; PostgreSQL major-version upgrade automation; migration of any existing data.

## Boundary Candidates

- Server: package, major version, extensions, preload, data directory, system account.
- Exposure: socket directory, `listen_addresses`, `pg_hba`, `pg_ident`, firewall, Serve absence.
- Provisioning: database, role, extension, and grant declarations, plus the idempotent bootstrap.
- LiteLLM: Prisma client packaging, schema initialization, socket URL, service ordering.
- Verification: guest eval assertions, scratch-cluster contract test, operator smoke.

## Out of Boundary

- `memory` database contents, total-recall migrations, and every iii worker/adapter.
- Semantic memory, embeddings, and retrieval behavior.
- Backup, restore, retention, disaster recovery, and replication.
- Dashboarding, metrics, slow-query tooling, and capacity tuning.
- Any TCP listener, `host` auth rule, firewall opening, or Tailscale Serve entry for PostgreSQL.
- LiteLLM model routing, provider credentials, and cost policy.

## Upstream / Downstream

- **Upstream**: the locked `nixpkgs-unstable` input (PostgreSQL 18.6, `pg_textsearch` 1.5.1, `pgvector` 0.8.7, `pg_uuidv7` 1.7.0); the NixOS `services.postgresql` module; LiteLLM 1.86.0 with Prisma 0.15.0; total-recall's PostgreSQL 17/18 and three-extension contract; sops-nix.
- **Downstream**: `install-total-recall-on-fabro-vm` (`memory` database, schema, migration runner, iii runtime, Serve, clients); LiteLLM virtual keys, spend logs, and admin UI; future workloads that declare a database through `fabro.postgres`; a future PostgreSQL backup/restore spec.

## Existing Spec Touchpoints

- **Extends**: `install-total-recall-on-fabro-vm` — replaces its `services.postgresql` server, extension installation, and loopback-TCP posture (design C2, task 3.1); that spec keeps its `memory` database and role declarations (moved to `fabro.postgres`), schema SQL, migration runner, iii runtime, workers, Serve entry, and clients.
- **Adjacent**: `load-balancer-model-providers-using-litellm` (routing and catalog stay unchanged); `sqlite-backup` (durability pattern, no PostgreSQL backup); `configurations/fabro-vm/fabro.nix` and `opencode.nix` (LiteLLM consumers); `opencode-nono-sandbox`; `install-rex-in-fabro-vm` (guest module and assertion patterns).

## Constraints

- The guest is `aarch64-linux`; every package comes from the pinned flake inputs, and `pkgs.unstable` is already in the guest overlay chain.
- PostgreSQL 18 is the newest GA major; 19 is an RC in the pinned input, and total-recall supports only 17 or 18. Stable 26.05's `pgvector` 0.8.2 is below total-recall's 0.8.6 floor, so PostgreSQL and extensions come from `pkgs.unstable`.
- `services.postgresql.enableTCPIP = false` still sets `listen_addresses = "localhost"`; only `lib.mkForce` with an empty string removes TCP. The default `pg_hba.conf` also appends two `host` rules; force the authentication file to `local` rules only.
- `pg_textsearch` must be in `shared_preload_libraries`; `pgvector` must be 0.8.6 or later; `pg_uuidv7` supplies `uuid_generate_v7()`. The total-recall migration contract assumes all three.
- PostgreSQL runs as the fixed `postgres` system account. Workloads use dedicated roles and dedicated system accounts; no workload connects as `postgres`.
- `pkgs.litellm` 1.86.0 has no generated Prisma client for `litellm/proxy/schema.prisma`, and `proxy_cli.py` only bootstraps when a `prisma` executable is on `PATH`. The database path therefore needs both package generation and a schema-init unit, not only `DATABASE_URL`.
- Prisma documents socket URLs as `postgresql://user@localhost/db?host=/run/postgresql`; the pinned Prisma 0.15 client must honor that form. iii's database worker passes a `/`-prefixed `host` to `tokio-postgres`, which treats it as a Unix socket directory, so both consumers can stay socket-only.
- Schema initialization completes before `litellm.service`; the proxy runs with `DISABLE_SCHEMA_UPDATE=true` and never executes `prisma db push --accept-data-loss` at startup.
- No secret enters the Nix store. Peer authentication and `pg_ident` avoid a database password; any future password comes from the guest's sops store and a template with `restartUnits`.
- Data lives under `/var/lib/postgresql/18`; `users.mutableUsers` stays true, the Lima cidata user stays undeclared, and the existing `svc:fabro`, `svc:litellm`, and `svc:opencode` entries stay untouched.
