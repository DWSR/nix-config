# Research: install-total-recall-on-fabro-vm

External and repository findings behind `design.md`. Sources were read on
2026-11-03 against `DWSR/total-recall` `main` and the repository's locked
inputs.

## Sources

| Ref | Source | Used for |
|-----|--------|----------|
| R1 | <https://github.com/DWSR/total-recall> and its `README.md` | Architecture, repository layout, delivery semantics, runtime variables |
| R2 | `DWSR/total-recall` `flake.nix` at `main` | Exported packages, pinned iii release, per-system hashes, absent NixOS module and CLI package |
| R3 | `workers/*/src/config.rs` and `clients/harness-events-cli/src/config.rs` at `main` | Exact environment-variable names, defaults, validation |
| R4 | `workers/*/migrations/*.sql` and `crates/memory-store/migrations/0001_memory_schema_search.sql` at `main` | Schema objects, role names, grants, extension requirements |
| R5 | <https://workers.iii.dev/workers/database>, `/queue`, `/cron` (2026-11-03) | Worker versions, install model, configuration shapes, file-backed queue |
| R6 | <https://iii.dev/docs/0-24-0/using-iii/engine> (2026-11-03) | `config.yaml` only declares engine-lifecycle workers; project workers run under another supervisor |
| R7 | `iii-hq/iii` source at tag `iii/v0.24.0`: `engine/src/workers/worker/mod.rs`, `engine/src/workers/stream/config.rs` | Default listener hosts/ports for the worker WebSocket and stream listener |
| R8 | <https://opencode.ai/docs/plugins/> (2026-11-03) | Global plugin directory `~/.config/opencode/plugins/` and automatic loading |
| R9 | `integrations/pi-harness-events/README.md` and `package.json` at `main` | Pi extension loading, `HARNESS_EVENTS_BIN`, supported Node |
| R10 | `NixOS/nixpkgs` at the repository's locked revs `36fd15bb…` (26.05) and `d3b13ad7…` (unstable) | PostgreSQL 17 availability and extension versions |
| R11 | Repository files: `flake.nix`, `configurations/fabro-vm/*`, `overlays/default.nix`, `home-manager/mcp/default.nix`, `home-manager/common/{opencode,pi,agentmemory}.nix` | Existing patterns, option names, unit names, check hooks |

## Upstream total-recall facts

- The repository is a Rust workspace plus TypeScript adapters. It ships no
  NixOS module and its `packages` output does **not** export `harness-events`
  (R2). The CLI exists as workspace package `harness-events-cli` with binary
  `harness-events` (R2, R3).
- Exported `packages.<system>` attributes include `harness-ingestion`,
  `harness-event-persistence`, `session-post-processing`, `memory-embedding`,
  `mcp-worker`, `opencode-harness-events`, and `pi-harness-events` (R2).
- The upstream flake's `nixpkgs` input is `nixpkgs-unstable`; its
  `Cargo.toml` requires Rust `1.98.1` and edition 2024 (R2). The repository's
  `nixpkgs` (26.05) is therefore not a safe `follows` target for upstream
  builds.
- The upstream flake pins iii `0.24.0` with release hashes:
  - `aarch64-linux`: `sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=`
  - `aarch64-darwin`: `sha256-xCqLwRauaHLb9GIrLuRJEDKgbNK3UxKvuCqPbGR6ChI=`
  (R2).
- The MCP worker is stdio-only and exposes memory save/search/get/version-list
  tools; it validates configuration before taking ownership of stdout (R1, R3).
- Delivery is explicit: adapters fail open, the CLI makes one iii call per
  event, and the ingestion worker publishes to a durable topic. Queue delivery
  is not exactly-once (R1).
- `harness-events` commands are `session-start`, `observation`, and
  `session-end`; only `III_URL` and `III_NAMESPACE` configure it (R3).
- OpenCode and Pi adapters invoke the `harness-events` executable and inherit
  `III_URL`/`III_NAMESPACE` from the host process. `HARNESS_EVENTS_BIN`
  overrides the executable path (R9).

## Worker runtime contracts

Exact variables read by the worker binaries (R3):

| Worker | Required variables | Optional/defaulted |
|--------|--------------------|--------------------|
| `harness-ingestion` | `TOTAL_RECALL_QUEUE_TOPIC` | `III_URL`, `III_NAMESPACE`, `III_WORKER_NAME` |
| `harness-event-persistence` | `TOTAL_RECALL_QUEUE_TOPIC`, `TOTAL_RECALL_DATABASE` | `III_URL`, `III_NAMESPACE`, `III_WORKER_NAME` |
| `session-post-processing` | `TOTAL_RECALL_POST_PROCESSING_DATABASE`, `TOTAL_RECALL_POST_PROCESSING_MEMORY_DATABASE`, `TOTAL_RECALL_POST_PROCESSING_PROVIDER`, and the selected provider's token/model | cron expression (`0 * * * * *`), batch/concurrency/lease/model bounds, `III_URL` |
| `mcp-worker` | `TOTAL_RECALL_MEMORY_DATABASE` | embedding provider/model (absent = disabled), MCP bounds, `III_URL` |

- `TOTAL_RECALL_*_DATABASE` values are **iii database connection names**, not
  URLs. The persistence worker calls `database::execute` with
  `{db: <name>, sql, params}` (R3).
- The ingestion worker calls `iii::durable::publish` on
  `TOTAL_RECALL_QUEUE_TOPIC` (R3).
- Post-processing accepts `http` only for loopback hosts; public endpoints must
  be `https`. The provider is exactly `openai` or `anthropic`;
  `TOTAL_RECALL_POST_PROCESSING_OPENAI_OUTPUT_MODE` defaults to `json_schema`
  and also accepts `json_object` or `prompt` (R3).
- Post-processing reads the ledger and writes session/candidate tables; the
  migration hard-codes `session_post_processing_migrator` (owner) and
  `session_post_processing_application` (grants) (R4).

## Database facts

- Required PostgreSQL 17 or 18. Extensions: `pg_textsearch` (preloaded),
  `pgvector`, `pg_uuidv7`; `uuid_generate_v7()` comes from `pg_uuidv7`
  release 1.7.0 (R4).
- `crates/memory-store/migrations/0001_memory_schema_search.sql` creates
  `memories`, `memory_embeddings`, `memory_search_heads`, the projection
  trigger, the BM25 index, and grants `SELECT, INSERT` to
  `memory_application` (R4).
- `workers/harness-event-persistence/migrations/0001_harness_event_ledger.sql`
  creates `session_events` and `raw_observations` with
  `uuid_generate_v7()` defaults; `0002_session_embeddings.sql` creates
  `session_embeddings` and requires pgvector (R4).
- `workers/session-post-processing/migrations/0001_session_post_processing.sql`
  creates `session_records`, `session_processing_attempts`, and
  `session_memory_candidates` (R4).
- Upstream migrations are plain `CREATE TABLE`/`CREATE INDEX` statements with
  no `IF NOT EXISTS` and no migration ledger, so a re-run fails. A deployment
  must track applied files itself.
- The repository's locked `nixpkgs` (26.05) has all three extension
  attributes but `pgvector` 0.8.2, below the required 0.8.6. The locked
  `nixpkgs-unstable` input has `pgvector` 0.8.7 (R10). Therefore the guest
  takes PostgreSQL and the extensions from `pkgs.unstable`.

## iii 0.24 facts

- `config.yaml` may declare only engine-lifecycle workers: `configuration`,
  `iii-worker-manager`, `iii-http-functions`, `iii-stream`, `iii-sandbox`
  (R6). Project workers run under another supervisor or Compose and connect
  over `III_URL` (R6).
- `iii-worker-manager` defaults to `0.0.0.0:49134`; `iii-stream` defaults to
  `0.0.0.0:3112` (R7). Both must be set to `127.0.0.1` explicitly.
- The iii Rust SDK enables `tokio-tungstenite`'s `rustls-tls-native-roots`
  feature, so a `wss://` `III_URL` is supported by the CLI, the workers, and
  the MCP worker (R7).
- The 0.24 engine binary opens only those two listeners; no HTTP/REST listener
  is bound by the engine itself, so the loopback bindings above cover every iii
  listener this deployment starts (R7).
- The engine injects iii-engine-functions, telemetry, and observability; do not
  declare them (R6).
- The configuration worker stores one YAML file per worker under its `fs`
  adapter directory. Each file carries `id`, `name`, `description`, and
  `value`; the directory is watched (R6 and iii configuration docs).
- Registry worker versions and `aarch64-linux` hashes read from the registry
  on 2026-11-03 (R5):
  - `database` 0.5.26: `a6a7434665fcaa6e91b73c935d5a157e376fabce079076b276f9173d0f84c17f`
  - `queue` 0.21.26: `3a181c65e9fb2c5dae9dbc665033af6645b20c33f15b8d50b91cdf97604dd6f9`
  - `cron` 0.21.28: `1b4db9de12ddb22399591fdab918441da93a5fb76c1c834223268d558f745370`
- The queue worker's builtin adapter supports `store_method: file_based` with
  a `file_path`, and persists on mutation (R5).
- The database worker's structured connection form supports
  `driver/host/port/user/database/tls.mode: disable` without a password; the
  default `tls.mode` is `require` and refuses a server without TLS (R5).

## Harness wiring facts

- OpenCode loads every `.js`/`.ts` file in `~/.config/opencode/plugins/`
  automatically. npm plugins are installed by Bun at startup; the upstream
  adapter has no production dependencies, so a single copied `dist/index.js`
  is sufficient (R8, R1).
- Pi reads `pi.extensions` from the package manifest and loads
  `src/index.ts` through its Jiti loader; the extension is enabled by adding
  the package root to the host's extension list (R9).
- The guest's OpenCode service reinstalls its config tree from the Nix store on
  every start, with `$XDG_CONFIG_HOME/opencode` as the global config directory
  (R11).
- mcpproxy renders `home.mcp.extraServers` stdio entries as `command`, `args`,
  and `env` (R11).
