# Research and Gap Analysis: total-recall-cutover

## Summary
Source inspection and supplied bounded research support a native deployment path, conditional on upstream work. No builds, compatibility tests or live deployment acceptance were performed for this document. The user approved requirements and conditionally approved design, requesting a task plan with operator provisioning; cutover authorization remains gated but secret-independent implementation is not.

The clean sibling checkout `/Users/brandonmcnama/repos/github.com/DWSR/total-recall` is at `7f9ac6628c33e0fa5212e818cec56495e4d51038` (verified through git MCP). This is a research baseline, not a deployable pin. Core product/tech/structure steering files are absent; repository code, relevant spec metadata and the confirmed brief supply context. The general roadmap remains historical context.

## Research Log

### Native artifacts and runtime topology
- [Total Recall flake at baseline](https://github.com/DWSR/total-recall/blob/7f9ac6628c33e0fa5212e818cec56495e4d51038/flake.nix) exports five production Rust workers: `harness-ingestion`, `harness-event-persistence`, `mcp-worker`, `memory-embedding`, `session-post-processing`; it also exports both harness adapters and a test-only fake engine.
- The flake does not export the adapters' `harness-events` CLI, iii engine, standalone supporting workers or a production service module. The native deployment must package the upstream CLI and queue/cron/database/router/provider workers and configuration rather than assume one executable supplies the stack.
- Supplied research identifies iii `0.24.0` native release archives and iii-workers research revision `36e15627d37583e98802a816cc22638188e0b4d5`. These require compatible immutable artifacts/hashes, state/config/secret wiring and registration readiness evidence; they are not approved deployment pins.
- The legacy iii builtin `file_based` queue uses persistent files with a five-second flush interval. It does not promise fsync-backed acknowledgement; abrupt-crash loss is distinct from clean restart recovery. The standalone queue selected in design has different persistence behavior; see Design Discovery below.
- The iii worker listener defaults to `0.0.0.0`; deployment must explicitly choose `127.0.0.1`. The bus has no assumed authentication and shares a trusted-local-user boundary, not hardened harness-subprocess isolation.
- Existing `overlays/agentmemory.nix` supplies only iii `0.11.5`, incompatible with this researched runtime. `overlays/default.nix` obtains AgentMemory from its flake and adds four patches plus npm dependencies; replacing only the old engine overlay would leave active AgentMemory packaging.

### PostgreSQL and schemas
- Baseline exports PostgreSQL 17/18 packages with `pg_textsearch` and `pgvector`; it omits `pg_uuidv7`. Supplied nixpkgs research found `pg_uuidv7` 1.7.0 available. Candidate packaging must demonstrate all three extensions on the selected Darwin PostgreSQL major, including `pg_textsearch` preload.
- Package raw SQL migrations for canonical memory (`crates/memory-store/migrations/0001_memory_schema_search.sql`), capture ledger/session embeddings (`workers/harness-event-persistence/migrations/0001_harness_event_ledger.sql`, `0002_session_embeddings.sql`) and processing state (`workers/session-post-processing/migrations/0001_session_post_processing.sql`). Role creation, ownership/grants, ordered version tracking and idempotent activation are deployment responsibilities; raw SQL is not an idempotent production migration runner.
- Worker database environment values identify iii database targets, not connection-string DSNs. The database worker resolves target names to runtime DSNs. Do not put a DSN in a target-name field.
- Current tools do not use the knowledge-graph schema; its migrations/workers are outside this cutover.

### Embeddings and reconciliation
- [Embedding config](https://github.com/DWSR/total-recall/blob/7f9ac6628c33e0fa5212e818cec56495e4d51038/workers/memory-embedding/src/config.rs) restricts `III_NAMESPACE` to `default`.
- The router/provider path is `router::embed` through `provider-openai` configured for oMLX's OpenAI-compatible endpoint on loopback port 8000. Use runtime Keychain `service=mcpproxy, account=omlx-api-key`; the existing generic SOPS/Keychain bridge supplies this secret seam.
- Current upstream provisioning lacks a committed-memory event-to-embedding-queue bridge. Periodic reconciliation can discover missing/stale embeddings without adding a remote iii bridge. Acceptance must cover both explicit saves and postprocessor commits and verify current-version retrieval.
- Existing `configurations/personal/home-manager/omlx.nix` supervises the server but does not provision models. The confirmed existing model is `Qwen3-Embedding-0.6B-4bit-DWQ`; endpoint/model availability, returned dimensions and database vector compatibility need candidate evidence.

### Harness compatibility and MCP result fidelity
- [MCP server](https://github.com/DWSR/total-recall/blob/7f9ac6628c33e0fa5212e818cec56495e4d51038/workers/mcp-worker/src/server.rs) accepts protocol `2026-07-28`, dispatches `server/discover` and validates per-request protocol metadata. Managed mcpproxy `0.67.0` requests conventional `2025-11-25` initialization. There is no proven compatible conventional initialize/notification/tool-call path at baseline.
- Both [OpenCode adapter](https://github.com/DWSR/total-recall/tree/7f9ac6628c33e0fa5212e818cec56495e4d51038/integrations/opencode-harness-events/src) and [Pi adapter](https://github.com/DWSR/total-recall/tree/7f9ac6628c33e0fa5212e818cec56495e4d51038/integrations/pi-harness-events/src) implement event submission, not the required ambient startup context. That capability must arrive upstream for both.
- Supplied managed-runtime research identifies OpenCode `1.18.32`, Pi `0.85.1` and Node `24.21.0`. `flake.lock` pins pi.nix at `9b16255c47cda6c925aabefa5609677902ff8197`. Baseline Pi tests target `1.0.0`; its wildcard peer dependency does not prove compatibility with managed Pi.
- Total Recall returns meaningful `structuredContent` with a completion-label text block. Actual `home-manager/common/extensions/pi-mcpproxy-go/index.ts` exposes structured data to the model only when content is empty. A bounded existing bridge result-rendering fix is allowed; a replacement MCP protocol facade is not. U1 verifies worker→managed mcpproxy preserves payloads/errors; full model-facing rendering, including OpenCode, is post-implementation evidence in tasks 9/14/15.
- Native harness event schemas determine what reasoning/tool activity is exposed. Compatibility evidence must enumerate lifecycle/prompt/assistant/reasoning/tool projections and retries for actual managed versions, with no claim of capturing unavailable events.

### Dedicated OpenAI OAuth
- [Current postprocessor provider](https://github.com/DWSR/total-recall/blob/7f9ac6628c33e0fa5212e818cec56495e4d51038/workers/session-post-processing/src/provider/openai_compatible.rs) builds `chat/completions` and uses a static bearer from `TOTAL_RECALL_POST_PROCESSING_OPENAI_API_TOKEN`; this is not a ChatGPT/Codex OAuth Responses implementation.
- OpenCode/Pi have provider authentication facilities, but user-owned harness credentials are not the selected deployment contract. No raw auth files were read. Existing provider auth is precedent for required behavior, not a credential source.
- Required upstream deliverables include a dedicated login/credential owner, OAuth account identity, Responses endpoint/headers/output parsing, expiry handling, atomic refresh persistence and concurrent refresh coordination. A base-URL change or static OAuth token passed to Chat Completions does not supply those capabilities.
- Exact processing model selection is explicitly deferred to the upstream gate. The selected account/model must support the structured generation operations used by session postprocessing; do not infer a Codex model from a harness default.

### Active cutover seams
- `home-manager/common/agentmemory.nix` installs the daemon/status/restart/reaper/Obsidian importer/cache-validation commands, MCP upstream, OpenCode plugin and two launchd jobs. `configurations/personal/home-manager/default.nix` enables it and names `agentmemory-bearer` alongside the unrelated oMLX secret.
- `home-manager/common/pi.nix` unconditionally references AgentMemory in the managed Pi extension/environment list and writes a private `${runtimeDir}/pi-bearer`. Updating only `programs.agentmemory.enable` cannot retire this integration; remove the managed bearer artifact during cutover.
- `home-manager/common/opencode.nix` reads/export the old bearer and composes `agents-agentmemory.md`; `opencode-nono.nix` and personal `opencode.nix` have old env/port allowances. Preserve the generic mcpproxy preflight, audit posture, port 8000 and unrelated ports/env.
- Update `home-manager/common/agents/*.md`, `pi-agent/instructions.md`, `subagent-context-budget/instructions/memory-mcpproxy.md` and its mirrored `plugin.ts` memory block. Check active compaction-context consumers while preserving native compaction and disabled title/summary agents.
- Retire `scripts/agentmemory-import-obsidian.nix`, its TypeScript source, `overlays/obsidian-importer-deps` and the `obsidian-importer-deps` export in `overlays/mcp-servers.nix`; remove only exclusively used dependencies after tracing callers. Direct inspection found no `scripts/obsidian-importer-deps` directory; the importer receives the overlay package through `callPackage`.
- Retire AgentMemory input/lock references, `overlays/default.nix` patch/dependency consumers, AgentMemory-only reaper/status/restart/cache-validation commands and obsolete `tests/agentmemory-opencode`/flake checks. Adapt useful cutover coverage instead of retaining old runtime assumptions.
- `home-manager/mcp/default.nix` has no active Obsidian integration. Cavemem/Obsidian agent paths were already retired; stale Pi status tests are not runtime evidence. Keep historical stores/vaults/specs and the Obsidian cask.
- `configurations/common-darwin/mcp-sops-bridge.nix` is the reusable generic secret seam. Retire old secret provisioning consumers without changing generic plumbing or deleting external Keychain data. Personal sqlite-backup currently has no configured memory backup; backups are not an implicit new requirement.

## Upstream Gates and Required Evidence
All gates remain unsatisfied. They are operator provisioning recorded in design.md and block cutover authorization, not secret-independent implementation. Candidate revisions may differ from the baseline and must be recorded with immutable artifact hashes. A source diff or upstream unit test alone is insufficient evidence of deployment compatibility.

| Gate | Owner / exact deliverable | Required evidence for cutover authorization |
|---|---|---|
| U1: MCP | Total Recall upstream: conventional worker→managed mcpproxy initialization/notifications/list/call and results fidelity, without local translation | Transcript against mcpproxy 0.67.0's 2025-11-25 initialize; conventional discover/save/recall/errors preserve meaningful structured payloads across proxy. No local harness-renderer completion precondition |
| U2: Both adapters | Total Recall upstream: full supported capture plus ambient startup-context selection/injection, bounded fail-open behavior; document existing delivery semantics | Evidence against actual managed lock/runtime versions (current OpenCode flake selection 1.18.35; previously researched Pi 0.85.1/Node 24.21.0); event matrix, capture/processing retry behavior, duplicate possibility, acknowledgement/crash-loss windows and recovery limits; first-response context, empty-store/stalled/unavailable-backend cases and session snapshot behavior |
| U3: OAuth | Total Recall upstream: dedicated login/credential store and Codex Responses provider, identity-preserving concurrency-safe refresh | Dedicated-account login, authenticated structured processing, forced expiry/concurrent refresh, failed refresh/re-login, private storage and redacted diagnostics |
| U4: Model | Operator with upstream provider owner: choose exact postprocessing model supported by the dedicated OAuth account | Recorded model identifier and successful representative postprocessing generation/output parsing over OAuth Responses; no API-key substitute |
| U5: Candidate contract inventory | Upstream publishes usable contracts/artifacts; nix-config records candidate sources | Immutable revisions, available artifact hashes and package inventory; supported database/extensions/schema, worker registration and persistence contracts. Local package builds and deployment verification follow in implementation tasks, not this gate |

U1–U3 are external feature prerequisites, not local facade tasks. U4 is the explicit unresolved user decision at the upstream gate. U5 spans upstream supply and local source/contract inventory; native Nix packaging/configuration, builds and runtime validation belong to implementation. Normal requirements/design/tasks approvals remain separately required.

Noncircular boundary: adapter capture/context contracts remain U2; local Pi rendering and both harnesses' model-facing end-to-end evidence belong to tasks 9/14/15 after implementation. U2/U5 candidate review must also establish admission compatibility for direct adapter entrypoints/configuration and managed CLI/MCP/worker startup; exact contracts are recorded before task 1, not redesigned by implementers.

## Gap Analysis
### Requirement-to-Asset Map
| Requirements | Existing assets | Gap classification / required change |
|---|---|---|
| R1 | Upstream baseline; flake.lock; this gate ledger | Missing U1–U3; Unknown U4/candidate pins; Constraint no facade bypass |
| R2 | Host memory enablement; existing historical stores | Missing fresh dedicated store and repeated-activation preservation; Constraint no import/backfill/dual-write |
| R3 | Upstream event adapters and ingestion/persistence/processing workers | Unknown actual-version event coverage/delivery limits; Missing managed CLI/services and candidate end-to-end evidence |
| R4 | Generic mcpproxy; existing Pi MCP bridge | Missing upstream conventional MCP; local structured-result rendering gap; Unknown OpenCode result fidelity |
| R5 | Capture adapters only | Missing upstream ambient startup context for both harnesses |
| R6 | oMLX service/keychain seam; static-token postprocessor | Missing upstream dedicated OAuth; Unknown exact processing model/vector compatibility |
| R7 | Nix overlay/launchd patterns; upstream workers/SQL | Missing native service assembly, migrations/roles/grants, supporting workers and reconciliation; Constraint queue flush/crash-loss limits |
| R8 | Upstream bounded dispatch patterns; current launcher checks | Unknown candidate startup fail-open/retry semantics; old launcher bearer hard failures require retirement |
| R9 | AgentMemory module, overlay, importer, prompts, private Pi bearer | Missing full active-consumer retirement and live-job stop lifecycle; Constraint historical data/adjacent behavior preserved |
| R10 | Existing package/module/host tests and upstream smoke fixtures | Missing candidate compatibility and live acceptance records; stale legacy tests need reachability review |

### Approach Options
The operator already selected native Nix. These are deployment-assembly options for later design, not a reopening of that decision.
- **A: Extend existing deployment patterns**: Replace the memory module/overlay contents while reusing launcher and launchd conventions. Fewer new surfaces, but old AgentMemory assumptions make lifecycle omissions harder to audit.
- **B: New dedicated runtime components**: Add a Total Recall package/module boundary with explicit SQL/service lifecycle, then wire both existing harness modules and retire the old boundary. Clear ownership, with more package/service assembly to verify.
- **C: Hybrid reuse**: Use upstream worker/adapter packages where compatible, package missing upstream runtime artifacts locally, add a dedicated service module, and reuse generic mcpproxy/secrets/harness seams. Strong alignment with current conventions, with an explicit compatibility matrix across upstreams.

### Synthesis and Design Research Needed
Hybrid reuse is the best-supported design candidate; all options depend on the same external gates. Local protocol/OAuth facades and partial harness cutovers conflict with the brief.

- Effort: XL including external prerequisite delivery; native deployment alone remains a substantial multi-service integration with unknown candidate artifacts.
- Risk: High until upstream MCP/context/OAuth and actual-version compatibility evidence exist.
- Blocking unknowns: exact processing model, compatible immutable revisions/artifacts/hashes, conventional MCP and startup contracts, dedicated OAuth storage/login/refresh contract and supported output semantics.
- Later design choices: PostgreSQL 17 versus 18, artifact sourcing, runtime directories/ports/job labels, migration version tracking/roles/grants, queue/cron registration ordering and health/status surfaces.
- Bound postprocessing/embedding recovery tests to upstream contracts. Do not promise capture durability during outages or fsync acknowledgement beyond actual queue guarantees.
- Preserve one feature boundary: gated deployment and hard cutover ship together. Upstream implementation remains externally owned; no local upstream-development tasks are implied.
- Initial requirements draft review checked numeric IDs, EARS criteria, scope and failure paths. Approval was absent at that review and subsequently supplied explicitly by the user; deployment acceptance remains absent.

## References
- [Total Recall immutable baseline](https://github.com/DWSR/total-recall/tree/7f9ac6628c33e0fa5212e818cec56495e4d51038) and local clean sibling inspected above.
- [iii 0.24.0 release](https://github.com/iii-hq/iii/releases/tag/iii/v0.24.0): native archive research candidate, not a validated pin.
- [iii-workers immutable research baseline](https://github.com/iii-hq/workers/tree/36e15627d37583e98802a816cc22638188e0b4d5): supplied supporting-worker research, not independently deployment-tested here.
- Local paths above are relative to `/Users/brandonmcnama/repos/github.com/DWSR/nix-config`; upstream paths are relative to the sibling Total Recall baseline. Prior bounded research supplied the engine/worker, managed-version and nixpkgs-extension findings; direct reads reconfirmed Total Recall exports, MCP dispatch, static-token provider, adapter entrypoints and live nix-config integration seams.

## Design Discovery: New Findings
Full complex-integration discovery used local baseline SQL/runtime/module reads and official PostgreSQL/pgvector/immutable iii-hq/workers documentation. No implementation or compatibility tests ran.

- Current `flake.nix` selects OpenCode `1.18.35`, not the earlier researched `1.18.32`. U2 evidence must target actual locked/runtime artifacts; Pi/Node versions also need candidate re-inventory.
- Baseline capture SQL (`workers/harness-event-persistence/migrations/0001_harness_event_ledger.sql`) defaults each receipt to `uuid_generate_v7()`. Persistence `src/database.rs:14–15` performs plain INSERT without supplied replay identity or conflict handling. Retrying persisted capture can create duplicate logical observations. The user adopts these documented upstream semantics; 3.3 requires candidate evidence/limits, not a dedup feature or local patch.
- Processing schema has unique source revisions, per-session nonterminal attempts and candidate fingerprints; canonical INSERT uses `(id, version)` conflict protection. These are partial evidence, not proof of end-to-end publish/ack retry safety.
- Canonical and session embedding SQL use unconstrained `vector`, with positive dimensions/norm or explicit dimensions checks. [pgvector documentation](https://github.com/pgvector/pgvector#vector-type) distinguishes storage limits from ANN index limits; this design retains upstream exact queries and does not invent `vector(n)`/halfvec indexes or model dimensions.
- [PostgreSQL 17 peer authentication](https://www.postgresql.org/docs/17/auth-peer.html) supports macOS local sockets and explicit username maps. The local design selects socket peer for admin and private runtime SCRAM DSNs for iii workers, avoiding an unverified database-driver socket assumption.
- Immutable [queue README](https://github.com/iii-hq/workers/blob/36e15627d37583e98802a816cc22638188e0b4d5/queue/README.md) specifies file-backed persistence **on mutation**, with `save_interval_ms` accepted for parity; this differs from the legacy builtin five-second flush described above. No fsync acknowledgement is established. It rejects a simultaneously active legacy queue builtin; named enqueue requires compatible engine support.
- Immutable [cron README](https://github.com/iii-hq/workers/blob/36e15627d37583e98802a816cc22638188e0b4d5/cron/README.md) specifies six/seven-field UTC schedules and skips missed fires. Embedding runtime registers `durable:subscriber`, `cron` and `memory::reconcile_embeddings`, with namespace `default`; scheduled reconciliation needs no committed-event bridge.
- Immutable [state README](https://github.com/iii-hq/workers/blob/36e15627d37583e98802a816cc22638188e0b4d5/state/README.md) requires persistent provider registration-token state and no competing legacy builtin. [Database](https://github.com/iii-hq/workers/blob/36e15627d37583e98802a816cc22638188e0b4d5/database/README.md) defaults TLS to require; loopback worker config must explicitly disable TLS and avoid its default SQLite target. Database/router/queue/state/cron depend on configuration; no top-level `configuration` artifact was found in that workers tree. Its actual owning artifact/config contract is a U5 inventory item, not an assumed executable.
- [Router](https://github.com/iii-hq/workers/blob/36e15627d37583e98802a816cc22638188e0b4d5/llm-router/README.md) owns provider configuration and reads fallback credential env in the router process. Provider `--config` is ignored; oMLX credential injection must target router resolution, not just provider environment. [OpenAI provider](https://github.com/iii-hq/workers/blob/36e15627d37583e98802a816cc22638188e0b4d5/provider-openai/README.md) supports embeddings but documents no OAuth refresh; it does not satisfy the dedicated Total Recall postprocessing gate.
- `home-manager/common/launchd-activation.nix` starts new jobs before old cleanup and continues after failures; some jobs can start before a later bootstrap fails. A memory-specific generation admission/completion barrier, strict pre-stop/post-verification and exact-job failure cleanup are needed. Confirmed stale Pi credential path is `${homeDirectory}/.agentmemory/pi-bearer`; cleanup must not recurse or delete external Keychain entries.

## Design Reference
Deployment decisions and the candidate revalidation procedure are owned by [design.md](design.md#candidate-review-external-selected-contracts).

## Design Validation Findings
Review followed kiro-validate-design against approved requirements and local architecture; absent core steering was compensated by direct repository reads. Strengths: explicit upstream/local ownership and strict same-generation hard cut with historical/new-data preservation.

- Mechanical repairs incorporated: migration-owner schema CREATE during migration; one-time password persistence; DSNs restricted to runtime configuration resolver/database worker; configuration artifact no longer asserted as an available standalone package; coordinated restart distinguished from independent launchd termination; namespace, limited bearer cleanup and strict old-job stop.
- Mechanical coverage: all 54 numeric acceptance criteria across ten groups appear in the traceability table; boundary sections and concrete file plan are populated, and every local component has a file boundary. External contract readiness is not claimed by those checks.

| Critical issue | Impact / required action | Traceability / design evidence |
|---|---|---|
| Conventional MCP, both startup adapters and dedicated OAuth still absent | No deployable memory contract; upstream must supply exact interfaces and compatible evidence through bounded revisit | 1.1, 1.5, 4.1, 5.1, 6.2–6.6; Candidate review, Harness wiring, Dedicated OAuth |
| Candidate inventory/model/runtime compatibility incomplete | Task 1 would guess artifacts/config/credentials; inventory configuration owner, independent worker hashes, extension/vector contracts, actual managed versions and deferred U4 model, then renew review | 1.2, 1.3, 6.6, 7.1, 7.4; Technology Stack, Candidate review, Database |

NO-GO for cutover authorization. U1–U5 and the issues above remain unsatisfied operator provisioning; task/design approvals cannot bypass them. Secret-independent packaging, wiring and fixture work may proceed against the operator-recorded candidate. No new user question is introduced: U4 remains the existing deferred decision. No build/live acceptance evidence exists.

### Resolved pre-task review policy
The user accepted documented upstream delivery semantics and replaced the unconditional 3.3 duplicate-prevention criterion. Baseline replay duplication is a documented limit, not an extra upstream feature prerequisite. Candidate capture/processing retry, duplicate, loss and recovery evidence remains required by U2 and 3.3; exactly-once delivery is not claimed.

### Conditional architecture revalidation
- Review context: approved requirements with revised 3.3, conditional design approval and direct reads of shared launchd activation and Pi result rendering. Core steering remains absent.
- Strengths: upstream/local ownership is explicit; strict old-job pre-stop corrects shared activation's start-before-cleanup behavior without changing generic machinery. Both harnesses share one live generation while historical and new data remain preserved.
- Critical issue 1: U1–U3 lack deployable MCP/context/OAuth interfaces. Impact: no usable two-harness contract. Action: upstream delivery and candidate evidence, then spec-owner revisit. Trace: 1.1, 1.5, 4.1, 5.1, 6.2–6.6; design Candidate review, Harness wiring, Dedicated OAuth.
- Critical issue 2: U4/U5 model and artifact/configuration inventory are unresolved. Impact: implementation would guess interfaces and pins. Action: record operator model selection and exact candidate contracts, revalidate and obtain renewed approvals before task 1. Trace: 1.2–1.3, 6.6, 7.1, 7.4; design Technology Stack, Candidate review, Database.
- Earlier review returned NEEDS_FIXES; renewed independent review accepted the repairs below with PASS for the plan. Retry duplication remains an adopted limit requiring evidence, not an extra feature blocker.

### Independent review remediation
- Finding 1: U1 required model-facing Pi fidelity before the blocked local renderer fix. Repair: U1 now ends at worker→managed mcpproxy protocol/payload preservation; U2 retains upstream adapter contracts and tasks 9/14/15 own post-implementation rendering evidence (1.1, 4.1–4.4).
- Finding 2: strict old-job stop did not contain partially successful shared bootstrap. Repair: design Cutover lifecycle defines generation identity, foundation/configuration verification, admission marker, completion provenance and revocation/exact-new-job cleanup; tasks 13/14 cover partial bootstrap failure (2.3–2.5, 8.1–8.4, 9.1).
- Candidate revisit must establish direct adapter admission compatibility through normal upstream configuration/entrypoint lifecycle before task 1; no guessed flags or local capture/context facade is authorized. Incomplete activation disables memory; later published-generation outages retain admission and upstream fail-open/retry behavior.
- Status: renewed independent verdict PASS for the plan with operator provisioning. Conditional design approval remains recorded; U1–U5 remain unsatisfied and cutover authorization remains blocked. Missing secret material does not block secret-independent implementation. No implementation or deployment acceptance evidence.
