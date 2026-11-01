# Implementation Plan: total-recall-cutover

## Plan status and operator prerequisites
This plan follows the repository secret-material handling rule. The user conditionally approved design and requested this plan. `ready_for_implementation` follows normal phase approvals. The prerequisite ledger below is operator-owned provisioning; it gates cutover authorization, not secret-independent packaging, wiring and fixture work. No task mints, reads, guesses or logs secret material. Missing secret material is recorded as `environment-blocked: secret-material-blocked (<item>) (<cause>)` and never produces `BLOCKED` or `_Blocked:`; only a task with no secret-independent work returns `NEEDS_CONTEXT`.

## Operator prerequisite ledger (design.md Operator Provisioning, not implementer tasks)
| Gate | Owner | Clearance evidence |
|---|---|---|
| U1: Conventional MCP | Total Recall upstream | Conventional worker→managed mcpproxy initialize/notifications/list/call and discover/save/recall/errors with structured payloads preserved across proxy; no local harness-rendering precondition |
| U2: Both adapters | Total Recall upstream | Actual managed-version capture matrix, first-response context, empty-store and bounded fail-open evidence; documented/tested retries, duplicate possibility, losses and recovery limits |
| U3: Dedicated OAuth | Total Recall upstream | Dedicated login/private credential owner, OAuth Responses structured processing, identity-preserving concurrent refresh, expiry and re-login evidence |
| U4: Processing model | Operator with upstream provider owner | Exact model selected by user at the deferred gate and proven with dedicated OAuth structured output |
| U5: Candidate inventory | Upstream supply; spec owner inventory | Immutable revisions/hashes and executable/configuration-owner contracts, schema/extensions/vector compatibility, worker registrations/persistence and actual harness versions |

The spec owner follows design.md, Candidate review, before task 1: populate `candidate-contracts.md` from candidate sources and compatibility evidence, replace pending contracts, revalidate, and obtain renewed approval. Exact pins/hashes, CLI flags, config keys and OAuth storage interfaces remain operator-owned until then. This is a provisioning precondition, not a task instructing an implementer to redesign the spec. Local derivation builds and deployment tests follow the record; they are not U5 preconditions.

Noncircular evidence: U2 owns upstream adapter contracts; tasks 9/14/15 own local model-facing rendering after implementation. The spec owner records U2/U5 generation-admission compatibility for direct adapter paths and CLI/MCP/worker startup before task 1, including source-supported configuration/entrypoint selection and fail-open disablement. An incompatible candidate returns to upstream/review, not implementer redesign.

## Execution constraints
- One gated deployment boundary. Local staging/tests use separate configurations/stores; both harness memory configurations are prepared for the same generation after old jobs stop. Foundation/configuration barriers precede generation admission; partial-bootstrap failure revokes admission and stops exact new jobs. This coordinates memory availability, not atomic OS activation or file replacement; no partial usable memory rollout, dual-write or old fallback.
- Adopt upstream delivery semantics; record permitted duplicates/losses/recovery limits. No exactly-once guarantee or extra dedup feature. No local protocol, capture/context or OAuth facade.
- Preserve historical stores/vaults/specs, external Keychain entries and Obsidian desktop. Use oMLX embeddings and dedicated Total Recall OAuth; no harness credential reuse.
- Operator provisioning follows design.md Operator Provisioning. Tasks wire runtime references only; no task invents, reads, commits or logs a secret. Missing secret material is recorded as `environment-blocked: secret-material-blocked (<item>) (<cause>)`, and a task whose only remaining work is operator provisioning returns READY_FOR_REVIEW with the operator action in `impl_concerns`.
- Tasks run in order; explicit cross-boundary dependencies are listed. No parallel markers: shared package/module/check exports and staged generation assembly require ordered integration. All verification is mandatory unless the verification is operator-owned secret material, in which case it is recorded as environment-blocked.

## Local tasks

- [ ] 1. Package reviewed Total Recall artifacts and database extensions
  - Adopt the operator-recorded immutable candidate sources/locks for production workers, both adapters, harness CLI and SQL assets; expose the selected PostgreSQL 17 extension set.
  - Verify native Darwin derivations and package inventory against the candidate record; reject the incompatible baseline and mutable downloads.
  - Do not mint, read or commit credentials; wire only the runtime reference paths recorded in design.md Operator Provisioning.
  - Completion: selected artifacts build and exports match the approved candidate record, including all three extension ABIs; any operator-only check is absent or recorded as environment-blocked.
  - _Boundary: Packages_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.1_

- [ ] 2. Package engine and standalone supporting artifacts
  - Package the reviewed engine and separate configuration-owner, state, queue, cron, database, router and embedding-provider artifacts/assets.
  - Use independent immutable provenance and verify named queue/registration compatibility; exclude fake engine and competing legacy builtins.
  - Do not generate or read provider credentials; the embedding key and OAuth login remain operator provisioning.
  - Completion: every required native executable/dependency builds and resolves without runtime registry installation.
  - _Boundary: Packages_
  - _Requirements: 1.2, 1.5, 7.1_

- [ ] 3. Establish module configuration and isolated verification foundation
  - Add typed personal-host options, generated public configuration, candidate provenance/model assertions and private path/listener declarations.
  - Create isolated test configuration/fixtures and check export before database/runtime tests; keep staged services out of live activation.
  - Completion: module evaluations enforce reviewed schemas/references and host scope, and the isolated test entrypoint executes without touching live stores.
  - _Boundary: Integration (Runtime, Acceptance)_
  - _Depends: 1, 2_
  - _Requirements: 1.3, 6.7, 7.1, 7.8, 9.6_

- [ ] 4. Initialize the private database and least-privilege roles
  - Configure PostgreSQL/extensions/preload, peer administration and loopback SCRAM application targets with one-time persisted private passwords.
  - Apply reviewed role ownership/grants, disable query-history credential persistence and reject non-loopback or unauthorized access.
  - Completion: isolated cluster initialization repeats safely; application operations succeed and prohibited DDL/roles/access fail.
  - _Boundary: Database_
  - _Depends: 1, 3_
  - _Requirements: 6.7, 7.4, 7.8_

- [ ] 5. Apply serialized checksum-tracked migrations
  - Package/apply ordered canonical, capture and processing SQL under reviewed owners with advisory locking, transaction handling and readiness ledger.
  - Test repetition, interrupted migration, checksum drift and incompatible schema refusal without destructive reset.
  - Completion: repeat migrations preserve isolated records and dependent-worker readiness remains false on migration failure.
  - _Boundary: Database_
  - _Requirements: 2.5, 3.2, 7.4, 7.6_

- [ ] 6. Assemble runtime configuration and private credential resolution
  - Resolve reviewed target/config references and DSNs only at runtime; configure persistent queue/state/configuration paths and upstream registration interfaces.
  - Wire the oMLX Keychain reference into the router and supply private dedicated OAuth storage/model configuration using upstream interfaces only. Do not run the operator login or read secret values; entries are in design.md Operator Provisioning.
  - Completion: generated public/store config and harness environments contain no credentials; private permissions and auth isolation checks pass. Any live secret-dependent check is recorded as `environment-blocked: secret-material-blocked (<item>) (<cause>)`, not BLOCKED.
  - _Boundary: Runtime_
  - _Depends: 2, 3, 4, 5_
  - _Requirements: 1.5, 6.1, 6.2, 6.3, 6.6, 6.7, 7.8_

- [ ] 7. Supervise services and coordinated restart recovery
  - Add launchd jobs, bounded schema/function/trigger registration barriers, restart throttling and candidate-compatible noninteractive worker handling.
  - Separate foundation bootstrap from workloads; require matching-generation admission for workload startup and matching completion for harness-facing CLI/MCP entrypoints without translating protocol/events/context.
  - Implement coordinated stop/restart and re-registration with persistent queue/provider/processing state; distinguish independent forced termination limits.
  - Completion: isolated clean restarts retain work/data and recover registrations without duplicate subscriptions; missing capabilities produce bounded redacted failures.
  - _Boundary: Runtime_
  - _Depends: 5, 6_
  - _Requirements: 7.2, 7.6, 7.7, 8.3, 8.5_

- [ ] 8. Schedule reconciliation and expose redacted capability status
  - Configure reviewed embedding queues and UTC reconciliation, recovering missing current-version embeddings without a committed-event bridge.
  - Report generation admission/completion and incomplete-memory-disabled versus published-degraded status, service/schema/queue/index/auth capabilities and upstream retry/DLQ/loss limits without secrets/transcripts/new servers.
  - Completion: isolated explicit saves and postprocessor commits become searchable after reconciliation; status distinguishes inference degradation from runtime readiness.
  - _Boundary: Runtime_
  - _Depends: 6, 7_
  - _Requirements: 3.2, 3.3, 6.1, 6.5, 7.5, 7.7, 8.3, 8.5_

- [ ] 9. Preserve meaningful Pi MCP results and errors
  - Extend existing typed result rendering to expose structured data alongside completion labels while preserving other blocks/details and avoiding equivalent JSON duplication.
  - Preserve structured diagnostics as errors and add focused success/error/rendering regression cases to the existing bridge tests.
  - Completion: post-implementation model-facing Pi results contain saved identity/content and structured diagnostics rather than label-only output; this evidence is not U1 clearance.
  - _Boundary: Pi bridge_
  - _Depends: 3_
  - _Requirements: 4.2, 4.3, 4.4_

- [ ] 10. Wire both upstream harness adapters and proxy-owned MCP
  - Install reviewed capture/context adapters with packaged CLI dependencies and configure one mcpproxy-owned stdio child using selected interfaces.
  - Use candidate-reviewed normal startup/config admission for both adapters, including direct paths; require matching admission and completion, otherwise select memory-disabled fail-open behavior without blocking ordinary turns.
  - Replace old bearer preflight/env and scope sandbox seams; require managed config while leaving capture/context/inference outages bounded and fail-open.
  - Completion: isolated harness launches use only the candidate adapters/proxy path, preserve quarantine, and receive no processing credentials.
  - _Boundary: Integration (Harness wiring, Runtime, Pi bridge)_
  - _Depends: 6, 7, 9_
  - _Requirements: 2.3, 2.4, 3.1, 3.4, 3.5, 4.1, 4.5, 5.1, 5.2, 5.3, 5.4, 6.3, 7.3, 8.1, 8.2, 8.4, 9.2, 9.6_

- [ ] 11. Update active memory guidance and mirrored consumers
  - Replace both harnesses' memory instructions with selected discovered tools, automatic upstream capture/context policy and honest delivery/failure limits.
  - Update agent, Pi, context-budget mirrored/plugin and active compaction-context references; retain disabled title/summary agents and native compaction.
  - Completion: active managed guidance consistently names Total Recall and its real interfaces, with no old-backend instructions or model-authored capture requirement.
  - _Boundary: Harness wiring_
  - _Depends: 10_
  - _Requirements: 3.4, 4.1, 5.4, 8.3, 9.5, 9.6_

- [ ] 12. Retire reachable legacy packages and integration consumers
  - Trace callers and remove AgentMemory module/input/overlay/patch/dependency/plugin/MCP/secret consumers and exclusive importer/operational surfaces.
  - Replace reachable legacy checks/status assumptions with new coverage; preserve generic plumbing, unrelated integrations, historical material and Obsidian cask.
  - Completion: staged host evaluation has no active old memory dependency/importer/secret consumer and preserves adjacent configuration.
  - _Boundary: Integration (Cutover, Packages, Harness wiring)_
  - _Depends: 10, 11_
  - _Requirements: 2.2, 2.3, 2.4, 9.2, 9.3, 9.5, 9.6_

- [ ] 13. Assemble strict same-generation cutover activation
  - Add generation-bound prepared/foundation/admitted/complete/incomplete state; preflight and stop old jobs/descendants with both existing harnesses closed before transition.
  - Verify exact foundation jobs/schema/registrations and both selected adapter/config structural barriers; publish/select same-generation memory configurations, then commit admission before workload entrypoints start.
  - Release both harness-facing memory paths only after workload registration and completion verification for that generation; admission alone cannot expose one usable integration early.
  - On bootstrap/completion failure revoke admission, withhold producers and stop exact new managed memory jobs/descendants already started; preserve data and report cleanup failures without old restart.
  - Initialize fresh-store provenance without imports; preserve later new data and remove only the reviewed managed Pi bearer with ownership/symlink checks.
  - Completion: partial-bootstrap and stale/missing-generation cases expose no usable partial memory; ordinary turns remain usable. Later published-generation outages retain admission and upstream fail-open/retry behavior.
  - _Boundary: Integration (Cutover, Database, Runtime, Harness wiring)_
  - _Depends: 5, 7, 10, 11, 12_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 8.1, 8.2, 8.3, 8.4, 9.1, 9.4, 9.6_

- [ ] 14. Verify integrated contracts and failure paths in isolation
  - After implementation, verify both harnesses' model-facing worker/proxy results and Pi rendering, capture/postprocessing/context, vector queries/reconciliation and migration/restart fixtures; rendering is not a U1 precondition.
  - Test shared activation starting some foundations before a later bootstrap fails, and post-admission completion failure: marker revoked, exact new jobs stopped, both memory producers withheld and ordinary turns/data preserved.
  - Test OAuth expiry/concurrent refresh/re-login with fixtures or isolated stubs, plus empty context, backend/inference stalls and recovery; record retry duplicates/lost acknowledgements/crash-loss limits against upstream semantics. Live account checks belong to design.md Operator Provisioning.
  - Completion: required automated checks pass on exact candidate versions; preserved adjacent behavior and source/automated evidence are separately recorded; no check requires a live secret.
  - _Boundary: Acceptance_
  - _Depends: 8, 9, 10, 11, 12, 13_
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 6.1, 6.4, 6.5, 6.6, 6.7, 7.4, 7.5, 7.6, 7.7, 8.1, 8.2, 8.3, 8.5, 9.6, 10.4_

- [ ] 15. Publish the operator runbook and acceptance harness for the live generation
  - Publish the operator login/re-login/lifecycle/limits runbook and a checked acceptance procedure that activates the verified personal generation through foundation/config barriers and admission/completion with both harnesses closed and old jobs stopped.
  - Run every secret-independent acceptance check and prepare the first-empty/repeated activation, both fresh-session capture/postprocessing/save/recall/next-session first-response context, recovery/reconciliation/OAuth and outage scenarios. Execute live checks only when the operator provisioning entries exist; otherwise record `environment-blocked: secret-material-blocked (<item>) (<cause>)` and note the operator action in `impl_concerns`.
  - Completion: runbook and acceptance harness exist and pass secret-independent checks; live model-facing evidence identifies candidate/generation/versions, admission/completion, delivery limits, absent old jobs/consumers and retained stores/vaults/Obsidian, or is explicitly recorded as pending operator provisioning. Never fabricate a credential or mark the task BLOCKED or `_Blocked:`.
  - _Boundary: Integration (Acceptance, Cutover, Harness wiring, Runtime)_
  - _Depends: 14_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.5, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 6.4, 6.5, 7.5, 7.6, 7.7, 8.1, 8.2, 8.3, 8.5, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.1, 10.2, 10.3, 10.4_

## Task-plan review
- Coverage mapping retains all 54 acceptance criteria and local design components. Candidate review is the named operator provisioning prerequisite, not numbered local work; mapping does not clear cutover gates.
- Independent task-graph review: PASS for a plan with operator provisioning after repairing circular U1/rendering evidence and partial-bootstrap containment. U1 excludes local rendering acceptance; generation admission/completion barriers have ordered checks and failure containment. This verdict does not clear cutover gates.
- Local units have bounded deliverables and no implementer redesign authority. Executability follows the operator-recorded candidate contract; missing secret material is environment-blocked evidence, not a blocked task. No implementation, build or live acceptance result is asserted by this review.
