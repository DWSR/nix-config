# Implementation Plan

> **Phases**: tasks 1–2 land the pinned packages and the guest module foundation,
> task 3 adds the guest memory database, task 4 the guest runtime, task 5
> post-processing, task 6 guest capture, task 7 the Serve exposure, task 8 the
> workstation clients, task 9 the evaluated checks, and task 10 verifies the
> running guest and cross-host recall.
>
> **Operator preconditions, not tasks**: the LiteLLM master key is provisioned as
> described in the design's `## Operator Provisioning` section (this plan only
> wires its placeholder), and the `svc:total-recall` Tailscale Service must
> already exist in the admin console and be granted to `tag:fabro`. Neither is
> created here.

- [ ] 1. Pinned packages and flake input

- [x] 1.1 Add and lock the total-recall flake input
  - Declare `total-recall.url = "github:DWSR/total-recall"` beside the other inputs in `flake.nix` with no `nixpkgs.follows` (upstream needs Rust 1.98.1 from its own nixpkgs)
  - Run `nix flake lock` so `flake.lock` records the input's `rev` and `narHash` plus the upstream-owned `nixpkgs` node
  - Add `totalRecall = inputs.total-recall;` to the `nixosConfigurations.fabro-vm` `specialArgs` block and accept `totalRecall` in the guest module that reads it
  - Add no alternate URL, mirror, vendored copy, or hand-placed source for any total-recall artifact
  - Completed when `nix flake metadata --json` shows a non-empty `locked.rev` for `total-recall` and the guest evaluation still succeeds
  - _Requirements: 1.1, 1.2_

- [x] 1.2 Build the pinned iii runtime and registry worker packages
  - Create `overlays/total-recall.nix` with `fetchurl` derivations for iii 0.24.0 (`meta.mainProgram = "iii"`), `database` 0.5.26, `queue` 0.21.26, and `cron` 0.21.28 using the `aarch64-linux` hashes recorded in `research.md`
  - Re-export `harness-ingestion`, `harness-event-persistence`, `session-post-processing`, `opencode-harness-events`, `pi-harness-events`, and `mcp-worker` from `totalRecall.packages.${system}` under the `total-recall-*` names in the design's C1 contract
  - Add the overlay to `custom-packages` in `overlays/default.nix` and record each version and hash in a comment so a bump is a reviewable diff
  - Keep upstream workers and adapters unpatched; resolve no URL at build time and add no registry lookup, `builtins.fetchTarball`, or fallback source
  - Completed when `nix eval --raw .#nixosConfigurations.fabro-vm.pkgs.total-recall-iii.version` reports 0.24.0, every `total-recall-*` attribute evaluates, and the overlay contains only fixed-hash URLs
  - _Requirements: 1.2, 1.4, 1.5, 1.6_
  - _Depends: 1.1_

- [x] 1.3 Add the repo-owned harness-events CLI derivation
  - Build workspace package `harness-events-cli` from the pinned input's `Cargo.toml`/`Cargo.lock` as `total-recall-harness-events`, following the repository's existing Rust overlay derivation style
  - Set `nativeBuildInputs = [ protobuf ]`, `doCheck = false`, and `meta.mainProgram = "harness-events"` so unit `ExecStart` lines use `lib.getExe`
  - Use hashed cargo dependencies only: no `cargo install`, no build-time network fetch, and no copied upstream source tree
  - Completed when the derivation evaluates for the guest and for `aarch64-darwin`, and its `meta.mainProgram` names `harness-events`
  - _Requirements: 1.3_
  - _Depends: 1.1, 1.2_

- [x] 2. Declare the guest totalRecall options, service account, and module enablement
  - Create `configurations/fabro-vm/total-recall.nix` with the design's `fabro.totalRecall` options: `enable` (default false), `iiiHost`/`iiiPort` (127.0.0.1/49134), `streamHost`/`streamPort` (127.0.0.1/3112), `databaseName`/`databaseConnection` (`memory`), `queueTopic` (`harness-events`), `postProcessingModel`, and `postProcessingBaseUrl` (`http://127.0.0.1:4000/v1/`)
  - Declare `users.groups.total-recall` and `users.users.total-recall` as a system user in that group; do not touch the Lima cidata account or `users.mutableUsers`
  - Import `./total-recall.nix` from `configurations/fabro-vm/default.nix` and set `fabro.totalRecall.enable = true` there
  - Declare no firewall opening, no database password secret, no `DynamicUser`, and no unit in this task
  - Completed when the guest evaluation exposes the option namespace with those defaults, `fabro.totalRecall.enable` is true, and the service account exists
  - _Requirements: 3.5_
  - _Depends: 1.2_

- [ ] 3. Guest memory database

- [x] 3.1 Enable PostgreSQL 17 with the three memory extensions on loopback
  - Set `services.postgresql = { enable; package = pkgs.unstable.postgresql_17; extensions = ps: [ ps.pg_textsearch ps.pgvector ps.pg_uuidv7 ]; }` in `configurations/fabro-vm/total-recall.nix` (26.05 ships pgvector 0.8.2, below the 0.8.6 floor)
  - Set `settings.listen_addresses = lib.mkForce "127.0.0.1"` and `settings.shared_preload_libraries = "pg_textsearch"`
  - Declare `ensureDatabases = [ "memory" ]` and the four roles `memory_migration`, `memory_application`, `session_post_processing_migrator`, and `session_post_processing_application`
  - Force the authentication block to `local ... peer` lines plus `host all memory_application 127.0.0.1/32 trust` and `host all all 127.0.0.1/32 reject`; add no password and open no firewall port
  - Completed when evaluation shows PostgreSQL 17 enabled, the three extensions in its package set, the four roles, the `memory` database, and a loopback-only listener
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 6.4, 6.7_
  - _Depends: 2_

- [x] 3.2 (P) Write the bootstrap and runtime-grant SQL
  - Add `configurations/fabro-vm/total-recall/bootstrap.sql`: `CREATE EXTENSION IF NOT EXISTS` for the three extensions, `memory` database ownership to `memory_migration`, and `ALTER SCHEMA public OWNER TO memory_migration` only when the catalog reports a different owner
  - Add `runtime-grants.sql` granting `memory_application` `SELECT, INSERT` on `memories`/`memory_embeddings`, `SELECT` on the ledger tables, and `SELECT, INSERT, UPDATE` on the three post-processing tables
  - Grant no `DELETE` anywhere and add no `DROP`, `TRUNCATE`, or non-conditional ownership change
  - Completed when both files apply twice to a scratch PostgreSQL 17 cluster with the three extensions and the second run reports no error and changes no object
  - _Requirements: 2.2, 2.3, 2.4_
  - _Boundary: configurations/fabro-vm/total-recall/*.sql_

- [ ] 3.3 Build the idempotent migration runner and ledger
  - Add `total-recall/migrate.nix` and `migrate.sh`: connect as `postgres` over the local socket to the module's database name, apply `bootstrap.sql`, then each upstream file whose name is absent from `public.total_recall_schema_migrations`
  - Apply exactly the design's four files in order: memory-store `0001_memory_schema_search.sql`, harness-event-persistence `0001_harness_event_ledger.sql` and `0002_session_embeddings.sql`, session-post-processing `0001_session_post_processing.sql`
  - Record `(name, sha256, applied_at)` per file, fail non-zero naming the file when an applied name's hash changed, and stop at the first `psql` failure
  - Copy the four migration sources from the pinned input into the derivation; keep the script free of `DROP`, `TRUNCATE`, and destructive `ALTER`
  - Completed when a first run applies all four and writes four ledger rows and a second run issues no DDL
  - _Requirements: 2.2, 2.3, 2.4, 2.5_
  - _Depends: 3.2_

- [ ] 3.4 Wire the total-recall-migrate service
  - Add `systemd.services.total-recall-migrate` as a `oneshot` running as `postgres`, `wantedBy = [ "multi-user.target" ]`, with `after` and `requires` on `postgresql.service` and no `StateDirectory`
  - Point `ExecStart` at the runner with the module's database name, set `Restart = "on-failure"`, and let `psql` errors reach the journal with the failing element named
  - Leave `postgresql.service` otherwise unmodified and do not gate PostgreSQL on the migration unit
  - Completed when evaluation shows the oneshot ordered after PostgreSQL, enabled at boot, and available as a `requires` target for the database consumers in tasks 4.3, 4.4, and 5.2
  - _Requirements: 2.3, 2.5, 2.8, 6.9_
  - _Depends: 3.1, 3.2, 3.3_

- [ ] 4. Guest memory runtime

- [ ] 4.1 Render the iii engine configuration and worker files
  - Render `config.yaml` with `pkgs.formats.yaml` declaring only `iii-worker-manager` (`127.0.0.1:49134`), `iii-stream` (`127.0.0.1:3112`, kv `file_based` at `/var/lib/total-recall/stream`), and `configuration` (fs adapter at `/var/lib/total-recall/config`)
  - Add `total-recall-config` as a `oneshot` with `RemainAfterExit`: copy the rendered config to `/var/lib/total-recall/iii/config.yaml` and write `database.yaml`, `queue.yaml`, and `cron.yaml` into the configuration directory
  - Use the design's structured database entry (`driver: postgres`, `host: 127.0.0.1`, `port: 5432`, `user: memory_application`, `database: memory`, `tls.mode: disable`, `pool.max: 10`, `history_max_entries: 0`), the builtin file-backed queue at `/var/lib/total-recall/queue`, and the `local` cron adapter
  - Keep secrets out of the rendered YAML and out of every `Environment=`; declare no `state` or `secrets` worker
  - Completed when the rendered config and the three worker files are in the store with loopback hosts, the `memory` connection name, and no credential
  - _Requirements: 3.1, 3.4, 3.5, 3.8_
  - _Depends: 2_

- [ ] 4.2 Add the iii engine service
  - Add `iii.service` running the pinned iii binary with `--config /var/lib/total-recall/iii/config.yaml`, `WorkingDirectory=/var/lib/total-recall/iii`, `User`/`Group` = `total-recall`, `Restart=always`, and `RestartSec=2`
  - Declare `StateDirectory` entries for `total-recall`, `total-recall/iii`, `total-recall/config`, `total-recall/queue`, and `total-recall/stream`, and `wantedBy = [ "multi-user.target" ]`
  - Order the unit `after` and `requires` `total-recall-config` and gate `ExecStartPost` on `127.0.0.1:49134` before the unit reports started
  - Bind only the two loopback listeners from task 4.1; add no HTTP/REST listener, firewall rule, or `DynamicUser`
  - Completed when evaluation shows the unit enabled at boot, restarting on exit, health-gated on the worker-manager port, and owning state under `/var/lib`
  - _Requirements: 3.1, 3.2, 3.5, 6.4_
  - _Depends: 4.1_

- [ ] 4.3 Add the iii database, queue, and cron worker units
  - Add `iii-database`, `iii-queue`, and `iii-cron` units running the task 1.2 packages with the shared `User`, `Group`, `StateDirectory`, `Restart=always`, `RestartSec=2`, and `wantedBy = [ "multi-user.target" ]` settings
  - Order every unit `after` and `requires` `iii.service`; order `iii-database` additionally `after` and `requires` `total-recall-migrate.service`
  - Keep the database worker on the `memory` connection entry from task 4.1 (no URL, no password, no `secret://` reference) and let an unwritable `/var/lib/total-recall/queue` fail `iii-queue` instead of falling back to memory
  - Completed when evaluation shows three separate units enabled at boot, restarting on exit, requiring the engine, and (for the database worker) the migration unit
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.7_
  - _Depends: 4.2_

- [ ] 4.4 Add the harness ingestion and persistence worker units
  - Add `total-recall-harness-ingestion` and `total-recall-harness-event-persistence` with `III_URL = "ws://${iiiHost}:${toString iiiPort}"`, `TOTAL_RECALL_QUEUE_TOPIC` on both, and `TOTAL_RECALL_DATABASE` on persistence, all read from the module options
  - Order both `after` and `requires` `iii.service`, `total-recall-migrate.service`, `iii-database`, `iii-queue`, and `iii-cron` so the observers and the topic exist before registration; use the shared `Restart=always`, `RestartSec=2`, and `wantedBy`
  - Run the pinned ingestion worker unchanged so it validates events against the pinned protobuf contract and rejects an invalid event with a bounded, payload-free error while staying registered
  - Set no embedding variable, second iii endpoint, or second database connection name
  - Completed when evaluation shows both units enabled with the shared endpoint and `memory` connection name, ordered after the migration and registry workers
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6_
  - _Depends: 4.3_

- [ ] 5. Session post-processing

- [ ] 5.1 (P) Add the total-recall-env sops template
  - Add `sops.templates."total-recall-env"` in `configurations/fabro-vm/default.nix` exporting `TOTAL_RECALL_POST_PROCESSING_OPENAI_API_TOKEN=${config.sops.placeholder."litellm-master-key"}` with `restartUnits = [ "total-recall-session-post-processing.service" ]`
  - Reuse the already-declared `litellm-master-key` secret that `litellm-env` renders; add no new secret, no new `fabro.onePasswordSecrets` entry, and no literal value
  - Leave the operator-side sync to the design's `## Operator Provisioning` row; this task only wires the placeholder
  - Completed when evaluation shows the template path outside the Nix store carrying only the placeholder and no unit `Environment=` block holding the token
  - _Requirements: 5.3, 5.4_
  - _Boundary: configurations/fabro-vm/default.nix_

- [ ] 5.2 Add the session post-processing worker unit
  - Add `total-recall-session-post-processing` with `TOTAL_RECALL_POST_PROCESSING_DATABASE` and `TOTAL_RECALL_POST_PROCESSING_MEMORY_DATABASE` set to the `memory` connection name, `..._PROVIDER = "openai"`, `..._OPENAI_BASE_URL` from `postProcessingBaseUrl`, `..._OPENAI_MODEL` from `postProcessingModel`, and `..._OPENAI_OUTPUT_MODE = "prompt"`
  - Set `EnvironmentFile = config.sops.templates."total-recall-env".path`, the shared `User`/`Group`/`StateDirectory`/`Restart` settings, and the same `after`/`requires` chain as task 4.4
  - Leave the worker's cron expression and inactivity window at the pinned defaults so an ended session is processed within one tick; a failed attempt must stay eligible for a later tick
  - Set no embedding provider or model variable and create no `memory-embedding` unit; the worker reads the ledger and never updates or deletes `session_events` or `raw_observations`
  - Completed when evaluation shows one enabled unit with the loopback gateway URL, the `memory` connection name, the sops env file, and no embedding or credential literal
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 5.7_
  - _Depends: 4.4, 5.1_

- [ ] 6. (P) Install the guest OpenCode capture plugin and capture environment
  - Copy `total-recall-opencode-plugin/dist/index.js` from task 1.2 into the declarative tree as `opencode/plugins/total-recall-harness-events.js` inside `configurations/fabro-vm/opencode.nix`'s `opencodeConfig` derivation
  - Add `III_URL=ws://127.0.0.1:49134` and `HARNESS_EVENTS_BIN=${total-recall-harness-events}/bin/harness-events` to the OpenCode unit environment and add the CLI to the unit `path`
  - Order `opencode.service` `after` and `wants` `total-recall-harness-ingestion.service` (never `requires`) so a memory outage cannot fail the console
  - Leave the model provider, workspace, authentication, `EnvironmentFile`, and config-tree reinstall behavior unchanged and introduce no forked plugin
  - Completed when evaluation shows the plugin file in the config-tree derivation with the loopback endpoint and CLI path and the soft ingestion ordering
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - _Boundary: configurations/fabro-vm/opencode.nix_
  - _Depends: 1.3, 4.4_

- [ ] 7. (P) Add the svc:total-recall Tailscale Serve advertisement
  - Add a fourth `ExecStart` entry to `tailscale-serve` in `configurations/fabro-vm/tailscale.nix`: `serve --service=svc:total-recall --https=443 http://127.0.0.1:49134`, emitted only when `fabro.totalRecall.enable` is true and placed after the existing three
  - Keep the oneshot `wantedBy = [ "multi-user.target" ]` so the same handler is re-applied on every boot and converges when already applied; a failing fourth line must leave the earlier three applied while the unit reports failed and journals the service name
  - Add `wants` (not `requires`) and `after` entries for `iii.service` and the three total-recall worker units, keeping `tailscaled.service` and `tailscaled-autoconnect.service` required and the existing three lines byte-for-byte unchanged
  - Add no firewall opening, no PostgreSQL target, no iii stream target, and no fallback that binds the memory endpoint elsewhere while the Service is absent
  - Update the existing `tailscale-serve` assertion in `flake.nix`'s `fabro-vm-guest-eval` check to require four `ExecStart` entries for the enabled guest, assert the new `svc:total-recall` entry targets `http://127.0.0.1:49134`, and keep the three existing advertisement assertions unchanged
  - Completed when evaluation shows four `serve` entries with the new service last, the memory units wanted but not required, the existing advertisements unchanged, the unit still enabled for boot re-application, and `nix flake check` passes
  - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 6.8, 6.9_
  - _Boundary: configurations/fabro-vm/tailscale.nix, flake.nix_
  - _Depends: 4.4, 5.2_

- [ ] 8. Workstation capture and MCP clients

- [ ] 8.1 Declare the home.totalRecall module and enable it on the workstation
  - Create `home-manager/common/total-recall.nix` with `home.totalRecall` options: `enable` (default false), `endpoint`, `databaseConnection` (default `memory`), and the client package options `harnessEvents`, `opencodePlugin`, `piExtension`, and `mcpWorker`
  - Import it from `home-manager/common/default.nix` and set `home.totalRecall = { enable = true; endpoint = "wss://total-recall.tuxedo-musical.ts.net"; databaseConnection = "memory"; }` in `configurations/personal/home-manager/default.nix`
  - Derive every adapter and MCP environment value from those two option values; repeat the URL and connection name in no consumer
  - Completed when the personal host evaluation exposes the option namespace and the module resolves one endpoint and one connection name
  - _Requirements: 7.3, 7.7, 8.3_

- [ ] 8.2 Install the capture CLI and both harness adapters
  - Add `harnessEvents` to `home.packages`, `opencodePlugin` as `xdg.configFile."opencode/plugins/total-recall-harness-events.js"`, and `piExtension`'s package root to `programs.pi.coding-agent.extensions`
  - Default the package options to the task 1.2 attributes so no per-host package override is needed
  - Leave the existing AgentMemory plugin, Pi extension, and launchd entries untouched, and add no local iii, PostgreSQL, or memory-store package or service
  - Completed when the personal host evaluation lists the CLI in `home.packages`, the plugin file under `~/.config/opencode/plugins/`, the extension in the Pi list, and no local memory runtime
  - _Requirements: 7.1, 7.5, 7.6_
  - _Depends: 8.1_

- [ ] 8.3 Export the capture environment for OpenCode and Pi
  - Export `III_URL = endpoint` and `HARNESS_EVENTS_BIN = ${harnessEvents}/bin/harness-events` through `home.sessionVariables`, `home.opencode.wrapperCommands`, and `programs.pi.coding-agent.environment`, all from the same two option values
  - Follow the existing shapes in `home-manager/common/opencode.nix` and `home-manager/common/pi.nix`; add no new wrapper, preflight, or second endpoint variable
  - Keep the adapters fail-open: no session-blocking preflight, no retry loop, and no path that aborts an OpenCode or Pi session when the endpoint is unreachable
  - Completed when the personal host evaluation renders both variables for both harnesses from the single endpoint and CLI path
  - _Requirements: 7.2, 7.3, 7.4_
  - _Depends: 8.2_

- [ ] 8.4 Add the total-recall mcpproxy stdio upstream
  - Add `home.mcp.extraServers.total-recall = { command = "${mcpWorker}/bin/mcp-worker"; env = { III_URL = endpoint; TOTAL_RECALL_MEMORY_DATABASE = databaseConnection; }; }` with no `args`, `type`, or `url`
  - Leave the upstream's memory save, search, get, and version-list tools unchanged and let mcpproxy namespace them like every other upstream
  - Keep mcpproxy the only MCP listener and `mcp-worker` stdio-only; add no HTTP MCP transport, no guest-side proxy, and no workstation service
  - Completed when the rendered `mcpproxy/mcp_config.json` contains the `total-recall` stdio upstream with the shared endpoint and `memory` connection name
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7_
  - _Depends: 8.2_

- [ ] 9. Evaluated verification

- [ ] 9.1 Assert guest unit coverage, boot enablement, restart policy, and ordering
  - Extend `fabro-vm-guest-eval` in `flake.nix` with assertions for `postgresql.service`, `total-recall-migrate`, `total-recall-config`, `iii`, `iii-database`, `iii-queue`, `iii-cron`, the three total-recall workers, and `tailscale-serve`
  - Assert each runtime unit is `wantedBy multi-user.target`, runs as the `total-recall` user with `Restart=always`, and that the migration oneshot runs as `postgres` with `after`/`requires` on `postgresql.service`
  - Assert the chain `postgresql → total-recall-migrate → iii-database`, `total-recall-config → iii`, `iii → workers`, and the workers → `tailscale-serve` as `wants`
  - Completed when removing any unit, its boot enablement, its restart policy, or a chain edge fails the check with a message naming that unit
  - _Requirements: 9.1, 9.11_
  - _Depends: 4.4, 5.2, 7_

- [ ] 9.2 Assert loopback bindings and the single tailnet exposure
  - Assert PostgreSQL `listen_addresses` is exactly `127.0.0.1`, the iii worker-manager and stream hosts are `127.0.0.1`, and no configuration-worker file names another host
  - Assert `tailscale-serve` has exactly four `serve` entries when `fabro.totalRecall.enable` is true, the memory one targets `http://127.0.0.1:49134` under `svc:total-recall`, the three existing entries are unchanged, and exactly the original three entries remain when the option is false
  - Assert the guest declares no firewall opening and no unit for a memory port other than the Serve target
  - Completed when a widened bind, an added or reordered Serve entry, or a changed existing advertisement fails with a message naming the port or service
  - _Requirements: 6.4, 9.2, 9.5_
  - _Depends: 9.1_

- [ ] 9.3 Assert schema prerequisites, worker environment, and secret placeholders
  - Assert `pkgs.unstable.postgresql_17.pkgs` provides `pg_textsearch`, `pgvector`, and `pg_uuidv7`, that `shared_preload_libraries` names `pg_textsearch`, that the four roles and `memory` database are declared, and that the migration derivation contains all four upstream migration paths
  - Assert every worker carries the same `III_URL`, ingestion and persistence share `TOTAL_RECALL_QUEUE_TOPIC`, every database consumer uses `memory`, and post-processing carries the loopback gateway URL, the model option, and the sops `EnvironmentFile`
  - Assert the `total-recall-env` content holds only the `litellm-master-key` placeholder and that no unit `Environment=`, rendered config, or template contains a gateway token
  - Completed when dropping an extension, a role, a migration, a shared variable, or the placeholder fails with a message naming the element
  - _Requirements: 2.2, 2.4, 3.5, 5.2, 5.3, 5.4, 9.3, 9.4, 9.9_
  - _Depends: 9.2_

- [ ] 9.4 Assert the guest capture plugin and the excluded components
  - Assert the guest OpenCode config-tree derivation contains `plugins/total-recall-harness-events.js` and the unit carries the loopback `III_URL` and `HARNESS_EVENTS_BIN`
  - Assert `opencode.service` `wants` (not `requires`) the ingestion unit and keeps its model, credential, and workspace settings
  - Assert the guest still declares no `mcpproxy` unit or package and no embedding variable or `memory-embedding` unit
  - Completed when dropping the plugin, the capture environment, or the soft ordering, or adding an MCP proxy or embedding unit, fails with a message naming the element
  - _Requirements: 4.2, 4.5, 5.7, 9.6, 9.8_
  - _Depends: 9.3_

- [ ] 9.5 Add the total-recall-host-wiring Darwin check
  - Add a check gated to `aarch64-darwin` that reads `self.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama`
  - Assert `home.totalRecall.enable`, the CLI in `home.packages`, the plugin file, the Pi extension entry, and both harness environments carrying the shared endpoint and CLI path
  - Assert `home.mcp.extraServers.total-recall` is stdio with `mcp-worker` and that the rendered `xdg.configFile."mcpproxy/mcp_config.json"` contains that upstream with the same endpoint and `memory`
  - Assert the host installs no iii or PostgreSQL package, declares no memory service, and renders no plaintext token
  - Completed when a missing client element, a local memory runtime, or a literal token fails the check with a message naming the host and element
  - _Requirements: 9.7, 9.8, 9.9_
  - _Depends: 8.4_

- [ ] 9.6 Add the total-recall-migrate-verify Linux check
  - Add an `aarch64-linux`-only check that initializes a throwaway PostgreSQL 17 cluster with the three extensions and runs the task 3.3 `migrate.sh` against it
  - Assert the four migrations are recorded, the nine tables exist, the roles hold the design's privileges, `uuid_generate_v7()` resolves, and `SHOW shared_preload_libraries` contains `pg_textsearch`
  - Assert a second run applies nothing and changes no row, then delete the temporary cluster without touching guest data
  - Completed when the check passes on a Linux builder and fails when a migration file or an extension is removed
  - _Requirements: 2.2, 2.3, 2.4, 2.5_
  - _Depends: 3.3_

- [ ] 9.7 Confirm pure evaluation and extend the guest report
  - Extend the `guestReport` string so the check output names the database, the migrations, the iii engine, all six workers, the Serve endpoint, and the capture plugin
  - Keep every guest assertion on pure evaluation plus the trivial `runCommand`: no guest build, no `aarch64-linux` derivation output, no network use beyond the flake fetch
  - Run `nix flake check` on the Mac and confirm the guest check and `total-recall-host-wiring` both pass without a Linux builder
  - Completed when the check passes on the Mac and its output text names each added element
  - _Requirements: 9.10, 9.11_
  - _Depends: 9.1, 9.2, 9.3, 9.4, 9.5_

- [ ] 10. Runtime verification on the guest and workstations

- [ ] 10.1 Verify guest boot ordering, unit health, and queue durability
  - Deploy with `lima-vm-deploy` and confirm `systemctl is-active` for PostgreSQL, `total-recall-migrate`, `total-recall-config`, iii, the three iii registry workers, and the three total-recall workers
  - Confirm `journalctl -u 'total-recall-*' -u 'iii*'` shows no ordering or bind error and that `psql` reports four ledger rows and the nine tables
  - Restart `iii.service` with a queued event and confirm the event is persisted after the restart
  - Completed when every unit is active and enabled, the ledger matches, and a queued event survives an engine restart
  - _Requirements: 2.1, 3.1, 3.2, 3.4, 3.7, 6.9_

- [ ] 10.2 Verify guest capture, persistence, and post-processing
  - Start a guest OpenCode session, produce an observation, end it, and confirm `session_events` and `raw_observations` gain rows with UUIDv7 receipts
  - After one cron tick confirm `journalctl -u total-recall-session-post-processing` reports a session record, a summary, concepts, and memory candidates, that the raw rows are unchanged, and that the loopback gateway was reached
  - Send one malformed event and confirm the ingestion worker rejects it and keeps serving
  - Completed when the captured session, its post-processed record, and the rejected-event behavior are all observed
  - _Requirements: 3.3, 3.6, 4.1, 5.1, 5.5, 5.6_

- [ ] 10.3 Verify tailnet reachability and cross-host retrieval
  - Confirm `tailscale serve status` shows `svc:total-recall` targeting `http://127.0.0.1:49134` and that `ss -ltn` shows only loopback listeners on 5432, 49134, and 3112
  - From the workstation, save a memory through mcpproxy's `total-recall` upstream and search for it from a second client to prove one shared store
  - Confirm mcpproxy's other upstreams still answer and that no workstation process listens for total-recall
  - Completed when the Serve handler is present, both ends read the same saved memory, and the other upstreams are unaffected
  - _Requirements: 6.2, 7.2, 8.4, 8.5, 8.6_

- [ ] 10.4 Verify idempotent re-switch, data survival, and fail-open paths
  - Re-run `nixos-rebuild switch` on the guest and confirm the migration step applies nothing, existing rows survive, and the iii worker settings converge without manual edits
  - Restart `opencode.service` and reboot the guest, then confirm previously captured sessions, session records, memories, and the Serve advertisement return without intervention
  - Stop the guest endpoint and confirm OpenCode and Pi sessions still work with no capture, while total-recall MCP calls return an error and every other MCP upstream stays available
  - Completed when the re-switch, service restart, reboot, and endpoint-down observations all match
  - _Requirements: 2.5, 2.7, 3.4, 3.8, 4.4, 4.6, 7.4, 8.7_
