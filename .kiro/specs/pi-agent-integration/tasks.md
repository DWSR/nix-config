# Implementation Plan

- [ ] 1. Establish the package and test foundation

- [x] 1.1 Pin the Pi source and expose the package skeleton
  - Add the pinned Pi flake source, repository overlay entry, patched-package placeholder, and extension-package placeholder.
  - Keep the upstream Pi wrapper off `PATH`; expose only package outputs consumed by later managed wrappers.
  - Assert `aarch64-darwin` support and a single Pi executable closure.
  - Done when both host evaluations resolve the base Pi package and extension manifest placeholders without command collisions.
  - _Requirements: 1.2, 1.5, 15.3_
  - _Boundary: Package Set_

- [x] 1.2 Create the deterministic test and flake-check harness
  - Add the Node test runner, isolated fixtures, writable copied-source setup, and check result conventions.
  - Provide fake Pi, provider, mcpproxy, Cavemem, nono, language-server, and subprocess probes for later tests.
  - Keep credential-bearing and switched-host tests outside pure derivations.
  - Done when a deterministic smoke fixture runs through the repository check harness on `aarch64-darwin`.
  - _Requirements: 15.3, 15.4_
  - _Boundary: Acceptance Harness_
  - _Depends: 1.1_

- [x] 1.3 Remediate the Pi production dependency advisory
  - Regenerate the Pi production lock so `undici` resolves to `8.9.0` or newer without changing unrelated dependencies.
  - Update the package dependency hash and preserve the pinned Pi source version.
  - Add a package assertion and advisory scan proving the affected version is absent.
  - Done when the package builds and the security check reports no unexcepted critical or high advisory in the production closure.
  - _Requirements: 1.2, 15.1, 15.5_
  - _Boundary: Package Set_
  - _Depends: 1.2_

- [x] 1.4 Backport and verify context-limit recovery
  - Apply the complete upstream recovery change for incomplete length-limited turns, including compaction and continuation behavior.
  - Carry source provenance and focused upstream tests with the patch.
  - Verify ordinary terminal events remain unchanged.
  - Done when an incomplete context-limit fixture compacts, resumes, and produces the expected assistant continuation.
  - _Requirements: 1.2, 15.2, 15.5_
  - _Boundary: Package Set_
  - _Depends: 1.3_

- [x] 1.5 Build the pinned public extension dependency closure
  - Lock the approved public extension versions and direct runtime dependencies without loading their mutable installers.
  - Preserve the Darwin ARM `node-pty` prebuild and verify one pipe and one PTY spawn.
  - Include required license texts and reject a nested Pi runtime or mutable source reference.
  - Publish package metadata that later entrypoint assembly can consume.
  - Done when the closure builds offline with exact versions, licenses, PTY support, and no duplicate Pi packages.
  - _Requirements: 7.1, 7.2, 7.4, 7.5, 15.1, 15.6_
  - _Boundary: Package Set_
  - _Depends: 1.2_

- [ ] 2. Build managed state and security foundations

- [x] 2.1 Define closed structural option contracts
  - Accept package-backed references for extensions, manifests, instructions, resources, and language-server executables, each paired with a canonical relative path; only the module may render complete store paths.
  - Limit provider configuration to the closed personal and Shopify role catalog, enabled-role and default-model references, and the `pi-auth`, `shopify-gateway-token`, and `shopify-gateway-base` resolver kinds.
  - Keep state, MCP, sandbox, sub-agent, plan, timeout, and advisory-exception values structurally typed, with no host-authored provider URLs, headers, model metadata, environment names, argv, shell text, public literals, or store strings.
  - Use real derivations plus relative paths in positive fixtures; add negative compile and evaluation fixtures for prior header, `runtimeBasePath`, credential-bearing `baseUrl`, secret-argv, and literal-store-root bypass shapes.
  - Done when valid fixtures evaluate and every removed bypass shape is unrepresentable at module evaluation.
  - _Requirements: 1.1, 1.3, 1.5, 2.7, 3.2, 7.1, 12.1, 15.1, 15.6, 15.7_
  - _Boundary: Home Module_
  - _Depends: 1.1_

- [x] 2.2 Render the fixed provider catalog and secret-free managed state
  - Make `ProviderCatalogV1` the sole source of the personal default and the five Shopify roles, including fixed routes, APIs, built-in model provenance, request policies, unsupported providers, and defaults.
  - Render `ManagedConfigV1` and expose a deterministic projection factory that emits `PersistedProviderProjectionV1` with catalog-ordered `PersistedProviderV1` rows from closed selections and joined catalog URLs.
  - Make the emitted projection the sole provider artifact consumed unchanged by Task 2.3; fixed generation and factory inputs must produce identical bytes with exact environment-reference templates and no token or launch UUID literals.
  - Preserve personal Pi authentication without a provider override and preserve xAI per-model APIs by omitting its provider-level API.
  - Render only package-backed output paths, disable telemetry, self-update, and unmanaged package behavior, and emit no artifacts or activation writes while disabled.
  - Use real derivations plus relative paths in render fixtures; keep heuristic secret scans as defense-in-depth after structural and schema validation.
  - Done when enabled, disabled, unsupported-system, catalog, and same-generation stability fixtures produce the exact managed artifacts without runtime values.
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.1, 2.6, 2.7, 3.2, 3.7, 7.5, 15.3_
  - _Boundary: Home Module, Provider Composition - Integration_
  - _Depends: 1.5, 2.1_

- [x] 2.3 Implement projection-only managed ownership and reconciliation
  - Accept only `PersistedProviderProjectionV1`; do not resolve provider bases, construct routes or headers, expand templates, or accept `ProviderRuntimeSecretsV1`.
  - Parse every managed JSON file as an object before mutation and reject malformed input without writes.
  - Track generation, pending/committed transaction state, owned pointers/providers, and prior value hashes.
  - Add, update, or remove only owned values; preserve unrelated settings, auth, trust, packages, providers, and sessions.
  - Fail on active managed drift instead of overwriting user changes.
  - Canonically order provider bytes, skip identical projections, and reject a different joined URL under the same generation as a projection conflict.
  - Done when add, update, stale-removal, no-op, projection-conflict, unrelated-value, invalid-JSON, and drift fixtures produce the specified complete result.
  - _Requirements: 2.1, 2.2, 2.3, 2.5_
  - _Boundary: Runtime Control_
  - _Depends: 2.2_

- [x] 2.4 Add reconciliation locking, atomicity, and recovery
  - Hold one integration lock and coordinate settings access with Pi-compatible locking.
  - Use private same-directory temporary files, flush completed content, and publish ownership only after every target is committed.
  - Recover or fail safely from pending transactions, interrupted writes, and lock timeouts.
  - Fail closed after `proper-lockfile` reports compromise; external lock replacement before heartbeat detection is outside the cooperative local-lock threat model.
  - Exercise concurrent launches against shared mutable fixtures.
  - Done when concurrent runs leave valid files from one complete generation with no orphan temporary files or unrelated changes.
  - _Requirements: 2.3, 2.4_
  - _Boundary: Runtime Control_
  - _Depends: 2.3_

- [x] 2.5 (P) Define the closed resolver plan and runtime-secret constructor
  - Derive only the three closed resolver plans from host selection; Shopify plans use the package-rendered `devx` executable and launcher-owned fixed argv, while personal Pi auth has no executable.
  - Keep plan derivation pure and execute no resolver process in this task.
  - Define a pure constructor that accepts injected validated resolver results and a fresh launch UUID, then partitions root-Pi, child-Pi, and scrubbed subprocess environments into `ProviderRuntimeSecretsV1`.
  - Expose in-memory `exactRedactionValues` through `ProviderRuntimeSecretsV1` without registering or consuming them in the unimplemented Capture Bridge.
  - Provide the scrubbed shell contract and expose no JSON encoder, ownership record, status form, rollback form, host-supplied environment name, or host-supplied argv.
  - Exercise plan derivation and constructor behavior with injected results, real derivations, and relative paths rather than fabricated store strings.
  - Done when pure fixtures produce exact plans and environment partitions, retain provider values only for root and child Pi, and keep every serializable surface sentinel-free.
  - _Requirements: 3.5, 3.6, 3.7, 14.1, 14.2, 14.3, 14.4, 14.5_
  - _Boundary: Credential Boundary_
  - _Depends: 2.1, 2.2_

- [x] 2.6 (P) Render the standalone Pi nono profile catalog
  - Pin and adapt the public Pi policy without runtime pack wiring, credential routes, git config, LaunchServices, or profile drafts.
  - Render managed, audit, and review profiles with explicit filesystem, network, environment, process, signal, and metadata deltas.
  - Preserve writable Pi/Cavemem/private-temp state and make review workspace access read-only.
  - Validate source and resolved profile JSON strictly against the selected nono version.
  - Done when all three profiles resolve with the expected grants and deliberately incomplete fixtures fail validation.
  - _Requirements: 5.1, 5.3, 5.4, 5.9_
  - _Boundary: Sandbox Catalog_
  - _Depends: 2.1_

- [x] 2.7 (P) Add the loader-stable Pi runtime bootstrap
  - Patch the managed Pi CLI entrypoint, without replacing `bin/pi`, to install `PiRuntimeBootstrapV1` before importing Pi modules or loading resources.
  - Derive personal mode when both managed provider variables are absent; require a non-empty bounded token and canonical launch UUID when both are present; reject partial or duplicate installation value-free.
  - Install one immutable, non-serializable capability on a versioned process-global symbol for the process lifetime; reload reuses it and each foreground child Pi creates its own capability.
  - Add no file, argv, stdin, `NODE_OPTIONS`, custom-entrypoint, or wrapper secret transport.
  - Done when personal, Shopify, partial-environment, duplicate-install, real-Jiti-load, reload, child-Pi, serialization, value-free-error, version, and direct-executable fixtures pass.
  - _Requirements: 1.2, 3.7, 4.3, 7.2, 10.3, 14.1, 14.2, 14.3, 14.4, 14.5_
  - _Boundary: Package Set, Credential Boundary — Runtime Bootstrap Integration_
  - _Depends: 1.4, 2.5_

- [x] 2.8 (P) Expose the loader-stable Cavemem subprocess environment
  - Extend the patched CLI with a separate immutable `CavememProcessEnvironmentV1` capability while preserving the closed Task 2.7 redaction capability and direct `bin/pi` entrypoint.
  - Generate its allowlist from Credential Boundary policy, preserve required runtime paths and `CAVEMEM_DATA_DIR`, and snapshot only own string data properties whose values contain no exact provider value.
  - Exclude provider credentials, undeclared variables, accessors, and test-only `CAVEMEM_NO_AUTOSTART`; reload reuses the process snapshot and each foreground child Pi creates its own.
  - Done when direct/reload/child fixtures prove exact allowed names, shared data-dir propagation, value-free rejection, immutability, non-serialization, and zero credential inheritance.
  - _Requirements: 3.7, 10.1, 10.6, 10.8, 14.1, 14.2, 14.3, 14.4, 14.5_
  - _Boundary: Package Set, Credential Boundary — Cavemem Environment Integration_
  - _Depends: 2.5, 2.7_

- [ ] 3. Add MCP and Cavemem integration contracts

- [x] 3.1 (P) Add the versioned Cavemem full-payload write mode
  - Add the explicit `pi-full-v1` control path only for canonical post-tool events; reject unknown modes and invalid canonical fields.
  - Store one versioned input/output envelope without the default truncation or grammar compression.
  - Preserve default hook parsing, content, metadata, compression, and exit behavior byte-for-byte.
  - Set uncompressed storage flags through the existing schema and insert path.
  - Done when a long full-mode fixture persists beyond legacy limits while the legacy golden fixture remains identical.
  - _Requirements: 10.3, 10.9, 10.10_
  - _Boundary: Cavemem Full Mode_
  - _Depends: 1.2_

- [x] 3.2 Implement context-bounded full-mode privacy
  - Own the focused privacy patch and privacy corpus without changing retrieval, embedding, or package-overlay wiring.
  - Recursively walk actual envelope objects and arrays before stringify, normalize structured keys as specified, and replace complete values only for the finite sensitive-key vocabulary.
  - Apply only private regions, complete authorization values, the finite provider-token forms, JWTs, private-key PEM blocks, and URL-authority userinfo beginning at lexical URL boundaries; malformed private or PEM openers redact through EOF.
  - Treat arbitrary string leaves as opaque and explicitly prohibit parsing embedded JSON, YAML, shell assignments, environment text, or source code.
  - Keep exact runtime-value removal bridge-owned; Cavemem diagnostics report only rule and structural location and never include a source value.
  - Add a leak corpus, a byte-identical false-positive corpus, and scaled malformed-input cases proving monotonic scanning under a timeout.
  - Done when every finite leak class is absent from persisted data and WAL evidence, every false-positive fixture is unchanged, and malformed inputs complete within the bound with value-free errors.
  - _Requirements: 10.3, 10.6, 10.9, 10.10, 14.4_
  - _Boundary: Cavemem Full Mode - Privacy_
  - _Depends: 3.1_

- [x] 3.3 (P) Implement raw retrieval and embedding exclusion for full rows
  - Own a separate storage-policy patch plus worker-lifecycle fixtures without changing privacy logic or package-overlay wiring.
  - Use already-redacted canonical fixtures from Task 3.1 and select behavior only from persisted compression and embedding state; this task does not own redaction.
  - Bypass expansion for `compressed=0` observations on every retrieval path and return the exact persisted bytes.
  - Restrict missing-embedding selection, live embedding, backfill, and vector enumeration to `compressed=1`, and remove stale vectors attached to full rows.
  - Bind the worker listener before PID-file access, stale-vector cleanup, or provider initialization; serve deterministic pre-ready health from the same listener.
  - Publish `worker.pid` atomically as a nonce-bearing readiness receipt only after cleanup and initialization; report started only after matching IPC or health readiness.
  - Let bind losers mutate no state: matching ready health means already running, while any other port owner fails as a conflict.
  - Compare-remove the receipt during shutdown while retaining the listener; restart waits bounded port release and escalates before spawning a successor.
  - Close store and listener on every startup failure and leave no receipt, child, listener, or partial vector cleanup.
  - Preserve all retrieval, expansion, embedding, and backfill behavior for default compressed observations.
  - Done when storage fixtures pass and lifecycle probes cover dead, malformed, live-unrelated, and failed-publication receipts; concurrent starts; cleanup failure; unrelated port ownership; and slow restart without false readiness or stale vectors.
  - _Requirements: 10.3, 10.7, 10.9, 10.10_
  - _Boundary: Cavemem Full Mode - Storage Policy_
  - _Depends: 3.1_

- [x] 3.4 Verify Cavemem storage limits and package compatibility
  - Wire the independently reviewed privacy and storage-policy patches into the Cavemem package before running combined compatibility checks.
  - Exercise a complete full-mode row at the active SQLite maximum fixture and a maximum-plus-one failure.
  - Assert limit failure stores no partial observation and reports the active storage boundary.
  - Verify `compressed=0`, null intensity, raw retrieval, embedding exclusion, FTS/BM25 discovery, and an unmodified schema version.
  - Extend package smoke coverage for default-mode parity and invalid-mode failure.
  - Done when the patched Cavemem package, smoke suite, raw retrieval, and legacy regressions all pass.
  - _Requirements: 10.3, 10.6, 10.7, 10.9, 10.10, 10.11, 15.3, 15.4_
  - _Boundary: Cavemem Full Mode - Integration_
  - _Depends: 3.2, 3.3_

- [x] 3.5 Implement Pi session lifecycle capture and backpressure
  - Load the bridge first and map session start, user input, assistant turn end, and session shutdown to existing Cavemem hooks.
  - Use Pi's stable session identity, `ide=pi`, configured working directory, and shared Cavemem data directory.
  - Serialize hook work through a FIFO and await it from event handlers instead of dropping accepted events.
  - Flush active work before compaction and shutdown, while treating reload as flush without session end.
  - Done when ordered session, prompt, stop, shutdown, reload, and failure fixtures produce searchable observations in one data store.
  - _Requirements: 10.1, 10.2, 10.4, 10.6, 10.8_
  - _Boundary: Capture Bridge_
  - _Depends: 1.5, 3.4_

- [x] 3.6 Capture complete pre-mutation tool results and failures
  - Snapshot tool events synchronously before the first await and before later extension mutation.
  - Consume the immutable `PiRuntimeBootstrapV1` capability during every Jiti factory load and remove each exact value from the snapshot before constructing JSON or spawning Cavemem.
  - Record successful and failed tool name, call identity, validated input, complete bounded-redacted content/details, usage, and outcome.
  - Use tool-execution completion as the fallback for validation, unavailable-tool, or blocked calls without a result event.
  - Invoke `pi-full-v1` and surface malformed, storage, redaction, and process failures as sticky sanitized Pi errors.
  - Done when real-loader/reload, later-mutator, success, tool-error, blocked-tool, unavailable-tool, stale-ID reuse, end-before-start, and sticky-error fixtures retain exactly one expected pre-mutation payload.
  - _Requirements: 10.3, 10.6, 10.9, 14.1, 14.4, 14.5_
  - _Boundary: Capture Bridge_
  - _Depends: 2.7, 3.5_

- [x] 3.7 Complete session lineage, child attribution, and hook isolation
  - Preserve identity on resume and compaction, create a distinct fork identity, and flush each transition in order.
  - Define child-attribution observations containing parent session, run, agent, and child index without changing Cavemem schema.
  - Pass only the managed scrubbed environment to Cavemem hook and worker processes.
  - Validate shutdown flush, no-secret logs/status, and discovery through the existing mcpproxy-routed Cavemem server.
  - Done when resume, fork, compact, attribution-fixture, scrubbed-environment, shutdown, and mcpproxy-search tests pass.
  - _Requirements: 8.6, 10.4, 10.5, 10.6, 10.7, 10.8, 14.1, 14.4, 14.5_
  - _Boundary: Capture Bridge_
  - _Depends: 2.8, 3.6_

- [x] 3.8 (P) Implement the isolated six-tool mcpproxy adapter
  - Create one in-memory adapter configuration for the standard local `/mcp` transport endpoint without ambient MCP-file merging.
  - Disable authentication discovery, resources, sampling, elicitation, script mode, and the generic proxy tool.
  - Freeze the six approved direct tools without prefixes and wait for eager metadata on cold start.
  - Exercise retrieve-then-describe and retrieve-then-read flows against a deterministic server.
  - Done when agent start exposes exactly six unique direct tools and a complete read flow returns the upstream fixture.
  - _Requirements: 4.1, 4.2, 6.1, 6.2, 6.3, 6.4_
  - _Boundary: MCP Bridge_
  - _Depends: 1.2, 1.5_

- [x] 3.9 Enforce MCP cache, approval, and preflight behavior
  - Cover cold, stale, partial, malformed, and concurrent metadata-cache starts with private atomic cache files.
  - Require allow-once/session approval for `call_tool_write` and `call_tool_destructive` and fail headless approval closed.
  - Preserve mcpproxy routing for `call_tool_read` without an additional Pi-side target-effect approval gate.
  - Probe health, readiness, mandatory upstream state, initialize, and exact tools before Pi starts.
  - Done when denied direct mutations reach upstream zero times, approved calls reach it once, routed reads remain usable, and every cache/preflight fixture converges on the six-tool surface.
  - _Requirements: 4.1, 4.2, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_
  - _Boundary: MCP Bridge_
  - _Depends: 3.8_

- [ ] 4. Configure and harden required Pi extensions

- [x] 4.1 Configure bounded sub-agent workflows and child resources
  - Support single, parallel, and chain execution with independent failures and predecessor-only chain input.
  - Expose only `reader` (host model, 8 turns, 32 tool calls, read-only parent workspace, local read tools plus read-only MCP, Cavemem) and `worker` (host model, 12 turns, 64 tool calls, read-write parent workspace, local read/write/command tools, Cavemem without MCP).
  - Apply the module-owned depth and reject call-level overrides of model, budget, tools, workspace/cwd, extensions, MCP, depth, output, or agent scope.
  - Store artifacts under the owning parent session and return results to the parent.
  - Load the Cavemem bridge and provider resources in every child; add MCP only when the agent declares it.
  - Done when single, parallel, chain, budget, hostile-override, tool-ceiling, child-capture, and session-artifact fixtures pass.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.8, 14.2_
  - _Boundary: Extension Runtime — Subagents_
  - _Depends: 1.5, 2.5, 3.7_

- [x] 4.2 Prevent detached sub-agents and owned process-group orphans
  - Reject async, detached, and scheduled child requests before process creation.
  - Prevent the controller from loading recursively in a child.
  - Run foreground children in process groups and escalate group termination after bounded graceful shutdown.
  - Cover explicit cancellation, parent shutdown, signal handling, and nested-child attempts.
  - Done when every denied mode is side-effect free and cancellation/shutdown releases the registered child process group and every ordinary descendant that remains in it without signaling a reused or unrelated group.
  - _Requirements: 8.5, 8.7_
  - _Boundary: Extension Runtime — Subagents_
  - _Depends: 4.1_

- [x] 4.3 Configure cooperative plan-mode state and transitions
  - Select read, grep, find, ls, and plan interaction tools by name at Plan entry and supported turn boundaries within the trusted managed extension order.
  - Block every non-allowlisted model tool call before execution and report the denial, including command, mutation, background, sub-agent, MCP mutation, and refactor apply calls.
  - Present completed plans for approval before restoration; explicit exit or cancellation restores captured registered names and reports unavailable names.
  - Record planning, approval, and captured-name state through Pi session entries; resume valid state and fall back to reported normal mode when state is unavailable or invalid.
  - Done when enter, reported denial, plan presentation, approve, explicit exit, cancel, unavailable-name restore, valid resume, and invalid-state fallback pass without blocked execution.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_
  - _Boundary: Extension Runtime — Plan_
  - _Depends: 1.5, 2.6_

- [x] 4.4 Configure local display timestamps
  - Display local timestamps after user and assistant turns without injecting text into model context.
  - Persist timestamp entries through reload and resume.
  - Keep the extension presentation-only and free of network, process, or telemetry behavior.
  - Done when fresh and resumed session fixtures show the expected local rows and context snapshots contain no timestamp text.
  - _Requirements: 11.1, 11.2_
  - _Boundary: Extension Runtime — Timestamp_
  - _Depends: 1.5_

- [x] 4.5 Establish managed Bash runtime inputs
  - Carry the positive bounded Home Manager Bash timeout unchanged in immutable managed state and publish one fixed launcher-to-extension binding.
  - Admit only values from 1 through 2147483647 milliseconds and declare the public binding for root and foreground child Pi outside provider-secret state.
  - Render one package-owned credential-scrubbed shell and make managed Pi settings own its absolute path.
  - Extend reconciliation to add, update, and remove only the managed shell path while preserving locking, atomicity, drift handling, unrelated settings, and activation purity.
  - Treat the wrapper as the trusted scrub boundary: root Pi may start it with provider state, but the model-controlled shell receives only the allowlisted environment without provider values or the timeout binding.
  - Done when a non-default timeout and package-rendered shell path render deterministically, shell-path ownership reconciles safely, root/child binding fixtures pass, and a sentinel command observes no removed value.
  - _Requirements: 2.1, 2.2, 2.3, 2.6, 2.7, 11.3, 14.1, 15.3_
  - _Boundary: Home Module, Runtime Control, Credential Boundary - Bash Runtime Integration_
  - _Depends: 2.4, 2.5_

- [x] 4.6 Configure default and explicit Bash timeouts
  - Consume only the launcher-owned managed timeout binding, reject missing or out-of-range values, and prevent mutable Supi timeout settings from overriding it.
  - Convert managed milliseconds to Pi timeout seconds only when a Bash timeout is omitted and preserve valid explicit seconds exactly.
  - Exercise Pi built-in Bash using Task 4.5's managed runtime inputs without modifying shell or reconciliation ownership, and rely on Pi's detached process-group timeout cleanup.
  - Done when hostile Supi overrides, a non-120000 default, explicit timeout, early completion, expired ordinary descendants, timeout reporting, and credential sentinels all produce the expected behavior.
  - _Requirements: 11.3, 11.4, 11.5, 14.1_
  - _Boundary: Extension Runtime — Timeout_
  - _Depends: 1.5, 4.5_

- [x] 4.7 Configure structured operator questions
  - Enable single-choice, multiple-choice, and free-text question forms outside plan mode.
  - Preserve ordered structured answers and recommendation metadata.
  - Make cancellation terminate the active turn without fabricating an answer.
  - Done when all question forms submit expected structured results and cancel produces the specified cancelled turn.
  - _Requirements: 11.6, 11.7_
  - _Boundary: Extension Runtime — Questions_
  - _Depends: 1.5_

- [x] 4.8 Configure managed code-intelligence capabilities
  - Consume only module-rendered language-server executables derived from packages plus canonical relative paths, and expose orientation, resolve, inspect, graph, find, health, and refactor-plan/apply tools.
  - Return source locations for definitions, references, implementations, hovers, symbols, and diagnostics.
  - Keep refactor preview no-write and apply as a separate operation.
  - Report unavailable server identity and cause without terminating unrelated Pi capabilities.
  - Done when a fixture server reports ready, returns known locations/diagnostics, previews without writes, and applies only after the apply call.
  - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5_
  - _Boundary: Extension Runtime — LSP_
  - _Depends: 1.5, 2.1_

- [x] 4.9 Isolate and clean up language-server processes
  - Launch only module-rendered package-backed server executables with the credential-scrubbed environment.
  - Keep one server failure isolated from other servers and Pi tools.
  - Perform protocol shutdown/exit followed by bounded process-group escalation.
  - Exclude refactor apply in plan and review modes.
  - Done when fake servers observe no credential sentinels, failures remain isolated, and session exit leaves no server process.
  - _Requirements: 12.4, 12.5, 12.6, 14.1_
  - _Boundary: Extension Runtime — LSP_
  - _Depends: 2.5, 4.8_

- [x] 4.10 Configure managed background pipe tasks
  - Expose stable task identifiers and status, bounded logs, wait, input, and termination operations.
  - Preserve deterministic ordering within each task while allowing independent tasks to run concurrently.
  - Report truncation and retain bounded operator-accessible output.
  - Route pipe processes through the credential-scrubbed environment.
  - Done when concurrent pipe fixtures expose correct IDs, order, status, waits, bounded logs, and no provider sentinels.
  - _Requirements: 13.1, 13.2, 13.4, 14.1_
  - _Boundary: Extension Runtime — Background_
  - _Depends: 1.5, 2.5_

- [x] 4.11 Add interactive PTY control and process-group cleanup
  - Enable attach, detach, input, signal, and kill operations for managed PTY tasks.
  - Preserve process state across detach and report final state after signal or kill.
  - Launch PTYs with the scrubbed environment and terminate the entire process group on task or session shutdown.
  - Verify the Darwin ARM PTY helper remains inside the sandbox and package closure.
  - Done when PTY interaction works, detach preserves the process, termination removes the group, and no sentinel reaches child output.
  - _Requirements: 13.3, 13.5, 13.6, 14.1_
  - _Boundary: Extension Runtime — Background_
  - _Depends: 4.10_

- [x] 4.12 Assemble the exact extension manifest and load order
  - Publish entry paths and versions for the two repository-owned and all approved public extensions.
  - Publish one closed, versioned provenance inventory with the immutable package root, canonical relative entry paths, and build-time content digests. Make the loader validate and expose this inventory so status consumes the same identity contract instead of re-deriving path rules.
  - Reject symlinked path components, package escapes, and digest mismatches before import or readiness reporting while accepting regular Nix-store files that are legitimately hardlinked by store optimization.
  - Order Cavemem first, then MCP, sub-agents, plan, timestamps, timeout, questions, code intelligence, and background tasks.
  - Disable ambient extension/skill/prompt discovery and omit Sieve, package-manager, telemetry, and nested Pi resources.
  - Run the MCP reserved-name and exact direct-surface validator after every managed extension has registered.
  - Fail validation on a missing, duplicate, incompatible, reordered, or unexpected extension.
  - Done when loader and status identity checks accept the same exact ordered inventory, tolerate legitimate hardlinks, and reject every altered manifest, symlink, escape, and digest fixture before a prompt or complete status.
  - _Requirements: 4.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - _Boundary: Package Set, Extension Runtime — Integration_
  - _Depends: 2.2, 3.7, 3.9, 4.2, 4.3, 4.4, 4.6, 4.7, 4.9, 4.11_

- [x] 4.13 Verify Plan controls with the assembled manifest
  - Load the complete managed manifest and register every custom tool before entering Plan mode.
  - Verify Plan selects its six managed names and reports denial of mutation, background, sub-agent, MCP-mutation, and refactor-apply calls before side effects.
  - Verify completed-plan presentation, approval, explicit exit, cancellation, unavailable-name restoration, valid resume, and invalid-state fallback.
  - Done when ordered-name snapshots, denial probes, and zero-side-effect checks pass for normal, Plan, resumed-Plan, and invalid-state modes.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 12.4, 13.7_
  - _Boundary: Extension Runtime — Plan Integration_
  - _Depends: 2.6, 4.3, 4.12_

- [ ] 5. Compose providers, sandboxing, status, and launch behavior

- [x] 5.1 Materialize the personal provider runtime contract
  - Consume the catalog-rendered personal projection with no provider override, endpoint, header, or Shopify resolver execution.
  - Use Pi-owned authentication and enforce `openai/gpt-5.6-sol` with `xhigh` as the managed default.
  - Preserve unrelated Pi authentication and provider state while producing the empty personal runtime-secret environment.
  - Keep heuristic Shopify-string scans as defense-in-depth after structural assertions reject Shopify roles, resolvers, and provider objects.
  - Done when personal fixtures resolve the default through Pi auth, preserve unrelated state, and contain no Shopify provider surface.
  - _Requirements: 3.4, 3.5, 3.7_
  - _Boundary: Provider Composition — Personal_
  - _Depends: 2.2, 2.5_

- [x] 5.2 Execute Shopify resolver plans and construct runtime secrets
  - Execute only the package-backed base and token plans from Task 2.5 with their fixed launcher-owned argv and bounded timeouts; personal mode executes none.
  - Validate process status and bounded outputs, require one non-empty token, generate a fresh launch UUID, and invoke the Task 2.5 constructor to produce validated `ProviderRuntimeSecretsV1`.
  - Return the resolved base candidate separately for Task 5.3 without joining routes or defining catalog, projection, or environment-partition behavior.
  - Report resolver kind and operation only; never place token, UUID, command output, or a credential-bearing temporary value in diagnostics or status.
  - Done when success, timeout, empty-token, command-failure, distinct-launch, and personal-no-dispatch process fixtures produce the exact constructor result and separate base candidate.
  - _Requirements: 3.1, 3.3, 3.6, 3.7, 14.2, 14.4, 14.5_
  - _Boundary: Credential Boundary_
  - _Depends: 2.5_

- [x] 5.3 Validate and hand off the Shopify persisted projection
  - Validate the Task 5.2 base candidate as HTTPS without userinfo, query, or fragment.
  - Join only the fixed catalog routes while retaining the validated origin, then invoke the Task 2.2 projection factory with the generation, closed selection, and joined URLs.
  - Pass the emitted `PersistedProviderProjectionV1` unchanged to Task 2.3 reconciliation while keeping `ProviderRuntimeSecretsV1` outside that boundary.
  - Do not define or modify projection schema, provider catalog, APIs, model provenance, request policies, header templates, or defaults.
  - Done when valid-base, invalid-base, route-join, factory-pass-through, stable-byte, and secret-exclusion fixtures produce the exact reconciliation input or fail before mutation.
  - _Requirements: 3.1, 3.2, 3.3, 3.7_
  - _Boundary: Provider Composition, Runtime Control — Integration_
  - _Depends: 2.2, 2.3, 5.2_

- [x] 5.4 Implement sandbox state and override resolution
  - Resolve host default plus `PI_NONO`, profile, listen-port, and rollback overrides.
  - Map disabled, audit, enforced, and review selections to the correct profile and final tool policy.
  - Validate explicit listen ports and reject wildcard, malformed, unknown-state, or unknown-profile input.
  - Report effective state/profile and accepted override values without launching Pi.
  - Done when every state transition, valid override, rollback, invalid value, and listen-port fixture resolves or fails exactly once.
  - _Requirements: 4.5, 5.2, 5.5, 5.6, 5.8_
  - _Boundary: Sandbox Catalog_
  - _Depends: 2.6_

- [x] 5.5 Integrate resolved grant checks with exact nono execution
  - Resolve and strictly validate the selected profile before launch.
  - Require mcpproxy port, provider network, package reads, writable Pi/Cavemem/temp state, workspace mode, admitted root-Pi variables, and same-sandbox process control for enabled capabilities.
  - Append review tool restrictions after user arguments so excluded tools cannot be restored.
  - Validate review arguments with a package-owned parse-only helper that statically imports `parseArgs` from the exact `piPackage` that supplies runtime `bin/pi`; run it with an empty environment and fixed working directory, and verify the reviewed Pi version and parser bytes before spawning it.
  - Do not accept a separate parser package or extract, transmit, or dynamically evaluate parser source. Reject parser errors, managed-suffix consumption, changed non-tool parse fields, or any effective review tool set other than `read`, `grep`, `find`, and `ls` before starting nono or Pi.
  - Attempt refactor apply and background start under review; assert zero writes, processes, and fallback execution.
  - Execute nono noninteractively with the selected profile and mandatory current-directory grant; execute bare Pi only for explicitly reported disabled state.
  - Fail closed on any missing grant, binary, profile, or capability prerequisite.
  - Done when exact command capture, parser-provenance and suffix-boundary fixtures, grant fixtures, and review side-effect probes cover normal, audit, review, rollback, missing-grant, and unavailable-nono paths.
  - _Requirements: 4.2, 4.3, 5.2, 5.6, 5.7, 5.8, 12.4, 13.7_
  - _Boundary: Sandbox Catalog, Runtime Control — Integration_
  - _Depends: 2.5, 3.7, 3.9, 4.2, 4.9, 4.11, 4.12, 4.13, 5.1, 5.3, 5.4_

- [x] 5.6 Implement redacted managed status
  - Report generation, Pi and extension versions, provider mode, sandbox state/profile, MCP endpoint/readiness, Cavemem directory/readiness, LSP state, and drift.
  - Support stable human and JSON formats without starting Pi.
  - Redact sensitive values and credential-bearing headers using the shared policy.
  - Identify missing or failed components with actionable recovery hints.
  - Done when complete, degraded, drifted, and sentinel fixtures produce stable output with no secret value.
  - _Requirements: 4.4, 14.4_
  - _Boundary: Runtime Control_
  - _Depends: 2.4, 3.7, 3.9, 4.12, 4.13, 5.1, 5.3, 5.4, 5.5_

- [x] 5.7 Implement the runtime compatibility validator
  - Validate package patches, desired/current JSON, ownership, profiles, extension inventory/order, MCP surface, Cavemem, PTY, LSP, and reconciliation drift.
  - Run check and dry-run modes without mutating Pi state or exposing credentials.
  - Classify each gate as pass, fail, or manual-required with versioned evidence.
  - Include recovery guidance for provider setup, profile selection, state repair, extension updates, and rollback.
  - Done when healthy, component-failure, drift, and manual-gate fixtures produce the expected report and exit status.
  - _Requirements: 4.1, 4.2, 4.5, 15.5, 15.7_
  - _Boundary: Runtime Control_
  - _Depends: 5.6_

- [x] 5.8 Compose the fail-before-TUI launch pipeline
  - Orchestrate Task 5.2 resolver execution and Task 5.3 projection handoff, reject authentication-precedence conflicts, and hold one integration lock across reconciliation and every managed JSON update.
  - Reconcile one complete generation before probing package, profile, mcpproxy, Cavemem, extensions, and runtime compatibility.
  - Stop before Pi on every provider, state, service, profile, extension, or validator failure and name its recovery action.
  - Exercise concurrent launches through the complete provider-and-reconciliation pipeline.
  - Done when ordered call traces match the design and concurrent fixtures commit one complete generation without opening the TUI on failure.
  - _Requirements: 2.1, 2.4, 3.1, 3.3, 3.6, 3.7, 4.1, 4.2, 4.5, 6.6, 7.3_
  - _Boundary: Runtime Control — Integration_
  - _Depends: 2.4, 3.7, 3.9, 4.13, 5.2, 5.3, 5.5, 5.7_

- [x] 5.9 Execute the final managed Pi surface exactly once
  - Reject install, remove, uninstall, and binary-update commands before Pi receives arguments.
  - Reject explicit extension, skill, prompt, and package paths; disable ambient resource discovery and append exact managed extension, instruction, skill, prompt, tool, and review arguments in authoritative order.
  - Clear sub-agent binary overrides so children use the underlying managed Pi runtime inside the same sandbox.
  - Export the immutable managed timeout binding to root and foreground child Pi, execute Bash through the reconciled managed shell path, and keep that binding out of the model-controlled shell environment.
  - Export the managed `CAVEMEM_DATA_DIR` before invoking Pi so hook and mcpproxy search paths share one store.
  - Invoke only patched `bin/pi`; do not import or call Pi `main()` from a launcher wrapper.
  - Execute the bare or nono-wrapped Pi package exactly once after successful preflight.
  - Done when mutation-command, normal, review, disabled, audit, and enforced fixtures capture one expected executable invocation and no alternate package path.
  - _Requirements: 1.6, 4.3, 5.2, 7.2, 7.3, 7.4, 7.5, 7.6, 11.3, 14.1_
  - _Boundary: Runtime Control — Integration_
  - _Depends: 5.8_

- [ ] 6. Wire the common module and both hosts

- [x] 6.1 Render Pi instructions, operator help, and exception guidance
  - Compose Pi-specific memory startup, mcpproxy discover-then-invoke, package, plan, subprocess, and rollback rules from current common contracts.
  - Exclude OpenCode-only commands and describe the six live direct MCP tools.
  - Render provider setup, managed status, sandbox overrides, configuration recovery, extension updates, and rollback help.
  - Document advisory-exception fields and expiry behavior in the technical help output.
  - Done when content tests find every required command/contract and no stale OpenCode, Sieve, direct Tool Gateway, or mutable install instruction.
  - _Requirements: 4.4, 6.4, 15.1, 15.7_
  - _Boundary: Home Module_
  - _Depends: 3.9, 4.13_

- [x] 6.2 Integrate all managed artifacts in the common module
  - Connect package outputs, closed selections, catalog rendering, credential policy, profiles, reconciler, launcher, status, validator, instructions, and help through the managed contracts.
  - Connect the package-owned scrubbed shell, managed timeout binding, Cavemem data-directory binding, timeout extension, and shell-path ownership through their approved boundaries.
  - Install only repository-owned managed commands while retaining the base Pi package as a closure dependency.
  - Render exact profiles and resource paths only when enabled.
  - Keep activation free of mutable Pi-state writes and secrets.
  - Done when common enabled/disabled evaluations expose the complete intended surface, activation artifacts are immutable, and all read-back options match status inputs.
  - _Requirements: 1.1, 1.3, 1.4, 2.6, 2.7, 2.8, 4.4, 7.1, 7.2, 7.3, 7.4, 7.5, 11.3, 14.1, 15.7_
  - _Boundary: Home Module — Integration_
  - _Depends: 2.2, 2.4, 2.5, 2.6, 3.7, 3.9, 4.13, 5.6, 5.7, 5.8, 5.9, 6.1_

- [x] 6.3 (P) Enable and verify the personal host contract
  - Enable the common Pi module with personal provider mode and audit sandbox default.
  - Select the catalog-owned `openai/gpt-5.6-sol` default at `xhigh` and leave Pi authentication plus built-in OpenAI provider state unoverridden.
  - Reuse the local mcpproxy endpoint, Cavemem directory, and common extension inventory.
  - Add a dedicated render fixture that structurally rejects Shopify roles, resolvers, provider objects, and runtime values; retain a closure scan only as defense-in-depth.
  - Done when the personal host evaluates to the exact usable managed surface with no Shopify configuration.
  - _Requirements: 1.3, 3.4, 3.5, 3.7_
  - _Boundary: Personal Host Configuration_
  - _Depends: 5.1, 6.2_

- [x] 6.4 (P) Enable and verify the Shopify host contract
  - Enable the common Pi module with Shopify gateway mode and audit sandbox default.
  - Select the five catalog roles and catalog-owned `openai/gpt-5.6-sol` default at `xhigh` without supplying routes, APIs, headers, resolver argv, or store paths.
  - Reuse the local mcpproxy endpoint, Cavemem directory, and Shopify-specific instruction addendum.
  - Add a dedicated render fixture using real package references and canonical relative paths, with no resolved token or launch UUID; retain generated-artifact scans only as defense-in-depth.
  - Done when the Shopify host evaluates to the exact closed role selection, managed catalog/default, and secret-free projection templates.
  - _Requirements: 1.3, 3.1, 3.2, 3.3, 3.6, 3.7_
  - _Boundary: Shopify Host Configuration_
  - _Depends: 5.3, 6.2_

- [x] 6.5 Add combined host render and static closure gates
  - Compare both host outputs for the same common package, profile, extension, command, and instruction versions with only declared provider deltas.
  - Run defense-in-depth scans over publishable closures for private Shopify source, mutable source URLs, credential sentinels, literal secrets, and missing licenses.
  - Verify unsupported-system evaluation still fails with the actionable compatibility error.
  - Keep these checks inside the test runner without final flake registration yet.
  - Done when both host renders and every static closure/evaluation gate pass from one deterministic runner invocation.
  - _Requirements: 1.5, 15.3, 15.6_
  - _Boundary: Acceptance Harness_
  - _Depends: 6.3, 6.4_

- [ ] 7. Prove integrated runtime and release readiness

- [x] 7.1 Verify the combined extension and direct-tool surface
  - Load the full managed manifest under the patched Pi runtime with ambient resources disabled.
  - Assert exact extension order, versions, six direct MCP tools, and required non-MCP tools before the first prompt.
  - Reject missing, duplicate, incompatible, generic-proxy, code-execution, Sieve, mutable-install, or telemetry surfaces.
  - Confirm required extension failure stops before accepting a prompt.
  - Done when the valid combined loader accepts one prompt and every altered inventory fixture fails with the named component.
  - _Requirements: 4.1, 4.2, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 15.4, 15.5_
  - _Boundary: Acceptance Harness — Extension Integration_
  - _Depends: 6.5_

- [ ] 7.2 Exercise all interactive extensions together under Pi
  - Run timestamps, Bash timeout, ask-user, plan transitions, code-intelligence preview/apply, and background pipe/PTY in one managed session.
  - Verify Plan selects managed names and denies other calls, while review hides execution and mutation tools after all extensions register.
  - Resume the session and verify timestamp and Plan state plus captured available-name restoration.
  - Confirm timeout and background process behavior remain independent.
  - Done when the combined runtime fixture completes every capability without tool collision, context pollution, or leaked process.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 15.4_
  - _Boundary: Acceptance Harness — Extension Integration_
  - _Depends: 7.1_

- [ ] 7.3 Verify nono filesystem, network, and review enforcement
  - Run managed, audit, and review profiles against allowed and denied workspace, state, cache, credential, Keychain, and mcpproxy paths.
  - Allow declared provider hosts and port 8080 while blocking unlisted ports and review writes.
  - Exercise explicit listen-port exceptions and malformed/wildcard rejection.
  - Assert a missing required grant fails before Pi and never falls back unsandboxed.
  - Done when every allow/deny probe matches the resolved profile and review leaves the workspace unchanged.
  - _Requirements: 5.3, 5.6, 5.7, 5.9_
  - _Boundary: Acceptance Harness — Security Integration_
  - _Depends: 7.2_

- [ ] 7.4 Verify supervised process cleanup under nono
  - Launch foreground child agents, language servers, background pipe tasks, and PTYs inside the selected sandbox.
  - Exercise cancellation, signals, session replacement, graceful exit, and forced escalation.
  - Inspect each registered process group after every path and reject a surviving
    owned group or ordinary descendant that remains in it.
  - Done when every owned process group terminates and no registered child,
    server, pipe, PTY, or helper PID remaining in that group survives session exit.
  - _Requirements: 8.7, 12.6, 13.6, 15.4_
  - _Boundary: Acceptance Harness — Process Integration_
  - _Depends: 7.3_

- [ ] 7.5 Prove provider credential isolation end to end
  - Inject unique sentinels and verify root and foreground child provider requests succeed.
  - Assert built-in Bash, background pipe and PTY, fake LSP, Cavemem hook and worker, status, and validator receive no sentinel.
  - Scan logs, temporary files, Pi session JSONL, Cavemem rows, and nono audit output for every sentinel.
  - Exercise normal, error, timeout, cancellation, and shutdown paths.
  - Done when all provider calls succeed and every non-provider process and persisted/logged artifact is sentinel-free.
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 15.4_
  - _Boundary: Acceptance Harness — Credential Integration_
  - _Depends: 7.1, 7.2, 7.3, 7.4_

- [ ] 7.6 (P) Run the personal hermetic end-to-end path
  - Launch the personal configuration with deterministic Pi authentication and provider fixtures.
  - Complete a prompt/tool turn, MCP discovery/read, Cavemem capture/search, child task, plan approval, PTY lifecycle, and status query.
  - Verify the personal default and absence of Shopify state throughout the flow.
  - Exit the session and scan for process, config, credential, and temporary-file residue.
  - Done when the full personal flow exits zero with searchable memory, exact status, no orphan process, and no Shopify artifact.
  - _Requirements: 3.4, 3.5, 4.3, 6.4, 8.1, 9.4, 10.7, 13.1, 15.4, 15.7_
  - _Boundary: Acceptance Harness — Personal_
  - _Depends: 6.3, 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 7.7 (P) Run the Shopify hermetic provider and runtime matrix
  - Exercise text, tool calls, reasoning, affinity headers, token failure, token expiry, and context recovery for every managed provider/API fixture.
  - Verify concrete route composition, model metadata, default selection, and auth-conflict failures.
  - Repeat the common prompt/MCP/Cavemem/child/plan/PTY path under audit and enforced profiles.
  - Keep all fixture tokens synthetic and assert redacted reports.
  - Done when all five provider/API modes and both sandbox states pass the complete hermetic matrix.
  - _Requirements: 3.1, 3.2, 3.3, 4.3, 15.2, 15.4, 15.5_
  - _Boundary: Acceptance Harness — Shopify_
  - _Depends: 6.4, 7.1, 7.2, 7.3, 7.4, 7.5_

- [ ] 7.8 Implement the switched-host Shopify live validation gate
  - Run the same five-provider text, tool, reasoning, affinity, token failure/expiry, and context-recovery matrix through live gateway credentials.
  - Validate audit and enforced launch behavior plus redacted managed status.
  - Emit versioned pass/fail evidence without request content, tokens, or credential-bearing headers.
  - Keep the gate `manual-required` until a switched host executes it successfully.
  - Done when the command produces a complete redacted report and blocks enforced rollout on any failed or unexecuted live gate.
  - _Requirements: 3.1, 3.2, 3.3, 15.2, 15.4, 15.5_
  - _Boundary: Acceptance Harness — Shopify Live_
  - _Depends: 7.7_

- [ ] 7.9 Register final checks and emit the readiness report
  - Register package, extension, unit, host-render, security, personal-runtime, and Shopify-runtime runners in the flake check graph.
  - Run pure regression and security checks and verify existing OpenCode plus default Cavemem behavior remains unchanged.
  - Recheck advisory status, licenses, private-source/secret closure scans, full-mode compatibility, and both host evaluations.
  - Aggregate pure pass/fail and live `manual-required` evidence into the versioned validation report.
  - Done when all pure checks pass and the report accurately blocks rollout until every mandatory live gate passes.
  - _Requirements: 10.10, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7_
  - _Boundary: Acceptance Harness — Integration_
  - _Depends: 7.6, 7.7, 7.8_

## Implementation Notes
- Task 1.3: When patches or `postPatch` replace an npm lock, override both `npmDepsHash` and `npmDeps`; inheriting the original fixed-output `npmDeps` leaves the old dependency graph in place.
- Task 1.4: Nix test derivations must install sorted semantic manifests, not raw runner logs containing paths, timestamps, durations, or execution order, so `nix build --rebuild` remains reproducible.
- Task 3.1: Versioned canonical envelopes use closed transport, envelope, and output key allowlists; unknown keys fail before any database insertion.
- Task 2.1: `types.package` and `lib.isDerivation` are structurally spoofable; bind package text/context to the selected output and force every public submodule's `_module.freeformType` to null.
- Task 2.2: Render exact schema fields and validated `package.outPath` values; never serialize broad option attrsets or coerce packages through host-controlled `__toString`.
- Task 2.3: Never claim an unowned same-ID provider, even when bytes match; same-generation projections must preserve the complete owned provider set and joined URLs.
- Task 2.4: The approved threat model covers cooperative local `proper-lockfile` users and fail-closed behavior after detected compromise; external lock replacement before heartbeat detection is treated as host compromise, not a fencing guarantee.
- Task 2.5: Bind package-backed `devx` through a trusted module-owned lexical output; inspecting arbitrary Nix `drvAttrs` to authenticate a package can trigger IFD or recursion.
- Task 2.5: Frozen method-only views still stringify as `{}`; exact-redaction membership must define a non-enumerable throwing `toJSON`.
- Task 2.6: Real nono child-environment probes require an unsandboxed macOS process because nested OpenCode/Nix Seatbelt cannot apply another profile; the selected-nono host probe passed with zero failures or skips.
- Task 3.2: Redaction must produce another valid `PiFullToolObservationV1`; a sensitive normalized key inside finite-number-only `output.usage` rejects the entire event with no row and a constant value-free privacy error.
- Task 3.3: The listener is the worker startup lease; `worker.pid` is only a nonce-bearing readiness receipt published after cleanup and initialization.
- Task 3.8: Use the standard MCP transport at `/mcp`; `/mcp/call` is not an adapter transport endpoint.
- Task 3.9: Direct write/destructive tools remain approval-gated; the operator accepted that mutations routed through `call_tool_read` rely on mcpproxy and may bypass Pi approval.
- Task 4.1: The fixed `reader`/`worker` catalog inherits the host model, rejects all call-level resource overrides, and never discovers mutable user/project agents.
- Task 4.1: Chain validation must recurse into nested parallel tasks, managed depth must ignore ambient overrides, and chain state belongs under the parent-session root rather than workspace `.pi-subagents`.
- Task 4.2: Darwin cleanup owns registered process groups and ordinary descendants that remain in them; first `ESRCH` is terminal for that ownership generation, and every async ingress must reject before observable state changes.
- Task 4.3: The relaxed contract uses Pi's name-based active-tool API and `tool_call` gate inside the fixed trusted extension order; schema/provenance sealing, final provider-payload/retry enforcement, and crash-atomic transitions are out of scope.
- Task 4.3: Preserve the first ordered pre-Plan tool capture across free-form Plan continuations; only a new normal or approved workflow may replace it.
- Task 4.4: Real `pi-stamp` acceptance fixtures must use TUI mode; persisted custom entries render on reload/resume but remain excluded from model context.
- Task 4.5: The managed timeout is authoritative at 1 through 2147483647 milliseconds, travels through `PI_AGENT_BASH_TIMEOUT_MS` outside provider secrets, and the trusted shell wrapper removes that binding plus provider values before model-command execution.
- Task 4.5: Sign the native Darwin scrubber with hardened runtime and no DYLD environment entitlement; ordinary ad-hoc signing permits inherited `DYLD_PRINT_*` leakage before `main()`.
- Task 4.6: Normalize raw Bash `timeout: null` before Pi validation and use a round-trip-safe seconds value satisfying `Math.trunc(seconds * 1000) == bashDefaultMs`.
- Task 4.7: Capture free text before the production editor trims it, ignore ambient Supi prompt config, and recheck cancellation immediately before constructing or persisting any answer.
- Task 3.5: Keep hook TERM/KILL and quiescence timers referenced until the owned process group is confirmed gone; unresolved promises and unref'd timers do not keep Node alive.
- Task 3.6: Consume the process bootstrap on each Jiti load; retain bounded strong redacted snapshots, use validated fallback input after `tool_call`, and ignore unknown ends or stale pre-validation results.
- Task 2.7: Install the immutable capability in patched `bin/pi` before dynamic Pi imports; read only own environment data properties, and select a replacement marker that contains neither exact value.
- Task 2.8: Keep Cavemem subprocess state in a separate policy-generated capability; include `CAVEMEM_DATA_DIR`, omit test-only and credential variables, and drop allowed values changed by exact redaction.
- Task 3.7: Keep canonical envelope keys trusted, bound dynamic data after redaction, emit deterministic once-per-child attribution, never reopen parent session paths, and end sessions only on terminal quit.
- Task 4.8: Apply the managed LSP patch with zero fuzz; refactor apply is one-shot, single-file, raw-byte/inode-stale, and metadata-verified before atomic rename.
- Task 4.9: LSP restart and session lifecycle must be single-flight and generation-fenced; retain every owned client until cleanup succeeds, and make lease release transactional and retryable.
- Task 4.10: An empty implementer handoff is a controller retry condition, not a repository blocker; restart the full RED/GREEN cycle in a fresh context.
- Task 4.11: On Darwin, node-pty's `IPty.pid` is the PTY process-group ID; inject group operations per task, and make escalation fixtures suppress only TERM while delegating probes and KILL.
- Task 5.1: Personal composition must match the catalog's exact provider/model default; an OpenAI-only check is insufficient.
- Task 5.2: Embed and digest the closed execution plan; bound resolver streams while reading, kill the detached group on failure, and never echo output.
- Task 5.3: Keep runtime secrets outside the handoff API; validate raw URL authority before WHATWG normalization and treat backslash as a path delimiter.
- Task 5.4: Host-default disabled is not rollback; disabled rejects profile/listen overrides, and ports use canonical comma-separated decimals.
- Task 4.12: Pi 0.83 has no public exclusive-loader or cancellable final pre-model hook; the approved boundary remains trusted and closed, with explicit extra-extension rejection owned by Task 5.9.
- Task 5.5: Treat Pi's parser as immutable selected-runtime code: verify its reviewed identity, then invoke it only through a fixed same-package helper with an empty environment; never extract or dynamically evaluate parser source.
- Tasks 4.12 and 5.6: Extension readiness must consume one loader-owned provenance inventory; status-only symlink or hardlink rules diverge from runtime, and Nix may legitimately deduplicate store files with hardlinks.
- Task 4.12: Anchor entry digests and the package root in a distinct Nix `identity` output referenced by production code; exported validators accept no caller-provided trust object or path.
- Task 5.6: Keep managed status at a command-byte boundary; reject sensitive environment descriptors below the root without invoking accessors, then scan the exact human or JSON bytes before output.
- Task 5.7: Normalize empty sandbox controls to absence, then reject any non-empty control containing an exact credential before spawning status or another validator probe.
- Task 5.8: Keep fixed launcher diagnostic labels separate from untrusted redaction values, and preserve value-free accepted-value and component-identity errors through preflight.
- Task 5.9: Root Pi execution must use the policy-owned environment allowlist; profile admission and rollback scrubbing are separate contracts from model-shell scrubbing.
- Task 6.2: Force every enabled common-module artifact, including resolver/status/validator outputs, in integration tests so package-contract failures cannot hide behind lazy evaluation.
- Task 6.3: Keep personal host selection limited to Pi-owned OpenAI auth and structurally reject Shopify provider surfaces rather than relying on closure scans alone.
