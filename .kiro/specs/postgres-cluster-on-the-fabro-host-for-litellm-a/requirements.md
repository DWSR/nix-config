# Requirements Document

## Introduction

This document defines the observable behavior of the Fabro guest's shared PostgreSQL cluster and of the LiteLLM proxy's use of it as its state store. The problem statement, current state, approach, and scope live in `brief.md`.

## Boundary Context

- **In scope**: replacing the approved total-recall spec's PostgreSQL 17 server, extension installation, and loopback-TCP posture with this one cluster, while that spec keeps its `memory` database body, schema, migrations, and runtime; the fixed `litellm` system account that replaces LiteLLM's dynamic account, including reuse of the existing LiteLLM state directory; one shared provisioning interface for databases, roles, extensions, and grants; the evaluated guest checks, the scratch-cluster contract check, and the operator smoke documentation.
- **Out of scope** (delta from `brief.md`): creating total-recall's `memory` database or any of its four roles in this change, applying total-recall migrations, and running any iii component; LiteLLM virtual-key issuance policy, budgets, spend-log retention, and admin-user lifecycle beyond persistence; connection pooling and per-database tuning; any network, tailnet, or cross-host database path; PostgreSQL major-version upgrades beyond the pinned 18.6, data migration from another cluster, and the macOS launchd LiteLLM module.
- **Adjacent expectations**: the pinned unstable input provides PostgreSQL 18.6 with `pg_textsearch`, `pgvector`, and `pg_uuidv7`; the NixOS PostgreSQL module owns the server unit and the `postgres` account; total-recall accepts PostgreSQL 17 or 18 and its migration contract requires the same three extensions; LiteLLM 1.86.0 ships its proxy schema and the Prisma client library; the guest's sops-nix store and templates remain its only secret path; the existing `svc:fabro`, `svc:litellm`, and `svc:opencode` Serve advertisements, the Lima cidata account, and `users.mutableUsers` stay unchanged.

## Requirements

### Requirement 1: One cluster on the supported version

**Objective:** As a workload operator, I want one PostgreSQL cluster on the version the workload contracts require, so that every workload shares one database service and one data directory.

#### Acceptance Criteria

1. The guest configuration shall declare exactly one PostgreSQL cluster.
2. When the guest boots, the guest shall start the cluster as an enabled system service.
3. The guest's cluster shall run PostgreSQL 18.6 from the repository's pinned unstable package set.
4. The guest's cluster shall keep its data under `/var/lib/postgresql/18`.
5. When the guest switches configuration, the switch shall preserve existing databases, roles, and rows.
6. When the guest boots, the cluster shall become ready before any workload that connects to it starts.
7. The guest shall run the cluster under the fixed `postgres` system account.
8. The guest shall run no second PostgreSQL server, cluster, or major version.
9. If the cluster fails to start, then the guest shall mark the cluster unit failed and record the error in the unit journal.

### Requirement 2: Socket-only exposure

**Objective:** As the guest operator, I want the cluster reachable only through the local Unix socket, so that no network path can reach database state.

#### Acceptance Criteria

1. While the cluster runs, it shall accept client connections through the `/run/postgresql` Unix socket.
2. While the cluster runs, it shall bind no TCP address or port.
3. The cluster's authentication configuration shall admit only local socket connections.
4. The cluster's authentication configuration shall contain no rule that matches a network address.
5. The guest's firewall configuration shall contain no opening for the cluster.
6. The guest shall publish no Tailscale Serve advertisement for the cluster.
7. The guest shall leave the existing `svc:fabro`, `svc:litellm`, and `svc:opencode` Serve advertisements unchanged.
8. When a client opens a TCP connection to the cluster's port on any local address, the connection shall fail.

### Requirement 3: Required extensions

**Objective:** As a total-recall and LiteLLM operator, I want the cluster to provide every extension those workloads require, so that schema migrations, vector search, and time-ordered identifiers work without a manual install.

#### Acceptance Criteria

1. The guest's cluster shall provide `pg_textsearch`, `pgvector`, and `pg_uuidv7`.
2. While the cluster runs, `pg_textsearch` shall be preloaded.
3. When an operator creates a scratch database, `CREATE EXTENSION` shall succeed for `pg_textsearch`, `pgvector`, and `pg_uuidv7`.
4. When `uuid_generate_v7()` is called in a database with `pg_uuidv7` installed, it shall resolve and return a UUID value.
5. The installed `pgvector` version shall be 0.8.6 or later.
6. If `pg_textsearch` cannot be preloaded, then the cluster shall fail to start and name the extension in the unit journal.

### Requirement 4: Declarative database provisioning

**Objective:** As the repo maintainer, I want databases, roles, extensions, and grants declared through one shared provisioning interface, so that a workload's database state exists after a switch with no manual step.

#### Acceptance Criteria

1. The guest configuration shall declare every workload database, role, extension, and grant through one shared provisioning interface.
2. When the guest switches configuration with a new database declaration, the provisioning step shall create the declared database without a manual command.
3. When the guest switches configuration with a new role declaration, the provisioning step shall create the declared role with its declared attributes.
4. When the guest switches configuration with a new extension declaration, the provisioning step shall install the extension in the declared database.
5. When the guest switches configuration with a new grant declaration, the provisioning step shall apply the grant to the declared role.
6. When the guest switches configuration with no declaration change, the provisioning step shall change no database object.
7. When the guest switches configuration after a failed provisioning run, the provisioning step shall converge without manual database cleanup.
8. If a declared object cannot be created or updated, then the guest shall mark the provisioning unit failed and name the declaration and the error in the unit journal.
9. The provisioning step shall complete before any workload that uses a declared database starts.
10. The provisioning interface shall be the only source of workload databases, roles, extensions, and grants on the guest.
11. The provisioning interface shall accept no literal database password.

### Requirement 5: Role separation and grants

**Objective:** As the guest operator, I want each workload to connect as its own non-administrative role from its own system account, so that no workload can administer the cluster or another workload's data.

#### Acceptance Criteria

1. The guest shall run the LiteLLM proxy under the fixed `litellm` system account.
2. The guest shall run no workload service as the `postgres` system account.
3. The guest shall admit no workload connection as the `postgres` role.
4. The guest shall grant no workload or migration role `SUPERUSER`, `CREATEDB`, or `CREATEROLE`.
5. The `litellm` database shall have one migration role and one separate application role.
6. The migration role shall own every object the schema-initialization step creates in the `litellm` database.
7. The application role shall hold the privileges the proxy requires to read and write the LiteLLM tables and their sequences.
8. The application role shall not create, alter, or drop a persistent database object in the `litellm` database.
9. When the proxy connects over the socket from the `litellm` system account, the cluster shall accept the connection as the application role without a password.
10. When the schema-initialization step connects over the socket as the migration role, the cluster shall accept the connection without a password.
11. Where the guest declares databases for two workloads, each workload role shall hold no privilege on the other workload's database.

### Requirement 6: LiteLLM database persistence

**Objective:** As a LiteLLM operator, I want the proxy to keep its state in the shared cluster, so that virtual keys, spend log entries, and admin UI users survive proxy restarts and guest reboots.

#### Acceptance Criteria

1. The guest configuration shall declare a `litellm` database for the proxy.
2. The proxy shall store its virtual keys, spend log entries, and admin UI users in the `litellm` database.
3. The proxy shall reach the `litellm` database only through the local Unix socket.
4. When an operator creates a virtual key, the key shall remain valid and listed after the proxy restarts.
5. When the proxy records a spend log entry for a request, the entry shall remain queryable after the proxy restarts.
6. When an admin UI user authenticates successfully, the same credentials shall authenticate again after the proxy restarts.
7. When the guest reboots, the proxy's virtual keys, spend log entries, and admin UI users shall remain.
8. The proxy's served model catalog shall remain unchanged.
9. The proxy's routing and failover settings shall remain unchanged.
10. The proxy shall continue to authenticate callers with its existing master key from the guest's sops-nix secret store.
11. When the guest switches LiteLLM to the fixed `litellm` system account, the proxy shall reuse the existing ChatGPT credential in its state directory.
12. The proxy shall not create, alter, or drop any persistent database object during startup or while serving requests.
13. If the proxy cannot reach the `litellm` database at startup, then the proxy service shall fail and record the connection error in the unit journal.

### Requirement 7: Schema initialization before the proxy

**Objective:** As a LiteLLM operator, I want one dedicated schema-initialization step, so that a failed or partial schema setup cannot leave the proxy serving on a broken database.

#### Acceptance Criteria

1. The guest shall run LiteLLM schema initialization as a step separate from the proxy service.
2. The schema-initialization step shall run after the cluster is ready and the `litellm` database and migration role exist.
3. The schema-initialization step shall run under the migration role.
4. When the schema-initialization step runs against an empty `litellm` database, it shall create the complete schema the deployed proxy requires.
5. When the schema-initialization step runs again after a successful run, it shall succeed and change no object.
6. When the schema-initialization step runs again after a failed run, it shall converge without manual database cleanup.
7. When the deployed proxy schema adds tables or columns, the schema-initialization step shall apply the addition before the proxy service starts.
8. If a schema difference would drop existing data, then the schema-initialization step shall fail and name the change instead of dropping the data.
9. When the schema-initialization step succeeds, the guest shall allow the proxy service to start.
10. If the schema-initialization step has not succeeded, then the guest shall not start the proxy service.
11. While the proxy service runs, schema updates shall be disabled.
12. When the proxy starts, it shall find its generated database client in its deployed runtime without generating a client or downloading a package.

### Requirement 8: Evaluated and runtime verification

**Objective:** As the repo maintainer, I want evaluated checks, a scratch-cluster contract check, and an operator smoke procedure, so that a regression in exposure, extensions, role separation, or schema ordering fails before it reaches the guest.

#### Acceptance Criteria

1. When `nix flake check` evaluates the guest, the Repository Checks shall fail if the cluster configuration binds a TCP address.
2. When `nix flake check` evaluates the guest, the Repository Checks shall fail if the cluster's authentication configuration contains a rule for a network connection.
3. When `nix flake check` evaluates the guest, the Repository Checks shall fail if a required extension is absent from the cluster's available extensions or from its preloaded extensions.
4. When `nix flake check` evaluates the guest, the Repository Checks shall fail if any workload's declared database identity is the `postgres` role.
5. When `nix flake check` evaluates the guest, the Repository Checks shall fail if any declared workload or migration role holds `SUPERUSER`, `CREATEDB`, or `CREATEROLE`.
6. When `nix flake check` evaluates the guest, the Repository Checks shall fail if the proxy runs with schema updates enabled.
7. When `nix flake check` evaluates the guest, the Repository Checks shall fail if the `litellm` database, its migration role, or its application role is absent from the declarations, or if the migration and application roles are not distinct.
8. When `nix flake check` evaluates the guest, the Repository Checks shall fail if the proxy service does not require the schema-initialization step.
9. When `nix flake check` evaluates the guest, the Repository Checks shall fail if the LiteLLM service does not run as the fixed `litellm` system account.
10. When the Scratch-Cluster Check runs, it shall start PostgreSQL 18.6.
11. When the Scratch-Cluster Check creates a scratch database, `pg_textsearch`, `pgvector`, and `pg_uuidv7` shall create successfully.
12. When the Scratch-Cluster Check connects to the scratch cluster, the connection shall use the Unix socket.
13. When the Scratch-Cluster Check probes the scratch cluster's port over TCP, no TCP endpoint shall accept the connection.
14. When the Scratch-Cluster Check runs the provisioning step twice, the second run shall change no object.
15. If any Repository Check or Scratch-Cluster Check fails, then the output shall name the offending configuration element.
16. While the checks run on a host without a Linux builder, the evaluated guest checks shall complete by pure evaluation.
17. The Operator Smoke Check shall document steps that verify socket-only reachability, the three extensions, the `litellm` database and role privileges, and the proxy's persistence across a restart, with the expected observation for each step.
18. The operator documentation shall state where the cluster's data, socket, and LiteLLM state directory live, how to add a database or role declaration, and how to inspect the proxy's schema-initialization result.

### Requirement 9: Credential-free database access

**Objective:** As the repo maintainer, I want database access to work without a stored password, so that no database credential enters the repository, the Nix store, or the service environment.

#### Acceptance Criteria

1. The repository, the Nix store, and the rendered guest configuration shall contain no PostgreSQL password or password hash.
2. The guest's database authentication shall require no password for any in-scope workload.
3. The guest's service journals shall contain no database credential.
4. Where the guest declares a database password, the guest shall source its value from the guest's sops-nix secret store.
5. When the rendered database password changes, the guest shall restart each consuming unit.
