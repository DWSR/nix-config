# Implementation Plan

- [ ] 1. Build the Obsidian memory importer
- [x] 1.1 Enforce the source-note boundary
  - Discover sorted direct Markdown children beneath the supplied `memories` directory.
  - Reject relative, missing, or unreadable roots before target access and report non-regular entries, symlinks, and path escapes without following them.
  - Verify source bytes and metadata remain unchanged after success, skip, and failure paths.
  - Completion is observable when temporary-vault tests cover valid files, nested files, missing or unreadable roots, in-tree and escaping symlinks, and immutable sources.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Boundary: Importer Core: Source Selection_

- [x] 1.2 Map notes to complete AgentMemory records
  - Parse optional frontmatter as untrusted input and report malformed or empty notes as skips.
  - Apply title, timestamp, type, project, topical-concept, source-file, origin-detail, and exact-body mapping from the design.
  - Derive stable path identities so changed content keeps its ID and a renamed path receives a new ID.
  - Completion is observable when canonical and fallback fixtures produce runtime-valid records, recall-visible provenance, exact bodies, same-path IDs, and rename-different IDs.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 4.1, 4.5_
  - _Boundary: Importer Core: Mapping_

- [x] 1.3 Validate wire contracts and build bounded batches
  - Runtime-validate every memory, the complete request with `exportedAt`, and the exact success or logical-failure response union.
  - Produce lexical memory-only skip batches with no more than 10,000 records and serialized size strictly below 8 MiB.
  - Isolate a single oversized record and enforce memories-only response count invariants.
  - Completion is observable when tests cover 10,000 versus 10,001 records, payloads one byte below versus at the byte ceiling, oversized singles, invalid request fields, and every invalid response field or count.
  - _Requirements: 3.4, 3.5, 3.6_
  - _Boundary: Importer Core: Wire and Batching_

- [x] 1.4 Execute dry-run, live import, and rerun reporting
  - Implement dry-run without target mutation and live authenticated submission with terminal auth handling and independent-batch continuation.
  - Aggregate discovered, eligible, imported, already-present, skipped, failed, and batch counts into the redacted JSON report and final exit status.
  - Keep the operation stateless; reruns retry missing IDs, leave existing same-path content unchanged, and create no rollback or journal state.
  - Completion is observable when mock tests prove complete success, existing IDs, partial batches, interrupted reruns, changed-content skip, malformed responses, auth failure, and zero or non-zero exits.
  - _Requirements: 3.2, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.2, 4.3, 4.4, 4.6_
  - _Boundary: Importer Core: Execution and Report_

- [x] 2. Package and expose the managed import command
  - Package the importer with Node 22 and the existing YAML dependency, accepting one absolute vault path plus dry-run and help modes.
  - Resolve the configured loopback endpoint and Keychain bearer only for live runs, with no secret in arguments, output, or the Nix store.
  - Install the command with AgentMemory on both configured hosts without invoking it during activation or startup.
  - Completion is observable when both host renders expose the command and help or dry-run works without a bearer while live mode fails cleanly when the bearer is unavailable.
  - _Requirements: 3.1, 3.3, 3.11_
  - _Boundary: Managed Import Command_

- [ ] 3. Apply the Obsidian hard cut
- [x] 3.1 (P) Remove Obsidian from managed MCP inventory
  - Remove the managed server, package, option, and both host vault-path values.
  - Add a rendered-config generation trigger so server-inventory changes alter the launchd definition and refresh the private runtime copy on the next managed start.
  - Preserve AgentMemory, unrelated MCP servers, source vaults, Cavemem data, and the Obsidian desktop cask.
  - Completion is observable when render tests show no Obsidian package, server, or option; a changed inventory changes the generation trigger; and unrelated servers and the cask remain.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Boundary: MCP Inventory Cutover_
  - _Depends: 2_

- [x] 3.2 (P) Remove Obsidian from startup checks
  - Simplify OpenCode preflight to mcpproxy liveness followed by authenticated AgentMemory health, without the admin-key server-list probe.
  - Make Pi require AgentMemory rather than Obsidian while preserving its four-tool adapter validation.
  - Keep nono on the composed preflight without widening permissions.
  - Completion is observable when OpenCode and Pi pass with Obsidian absent and still fail with the existing AgentMemory-specific recovery behavior.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  - _Boundary: Startup Cutover_
  - _Depends: 2_

- [x] 3.3 Replace global and Pi memory prompts
  - Make the AgentMemory fragment the sole active recall, save, lesson, and durable-memory policy; remove vault rules from global, Cavemem, cc-sdd, and Pi guidance.
  - Remove vault curator and synthesizer definitions, registrations, and common generated variants; do not modify Shopify host transformations in this task.
  - Convert hardcoded common memory paths to AgentMemory topic or title search hints.
  - Completion is observable when rendered global and Pi prompts use only AgentMemory through mcpproxy and the common agent catalog has no vault-only agents.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7_
  - _Boundary: Prompt Contract Cutover: Global and Pi_

- [x] 3.4 Retire Obsidian-dependent migration pipelines
  - Remove memory-sync module loading, backend enablement, script, tests, and flake check wiring.
  - Remove the obsolete Obsidian-to-Cavemem importer from the Cavemem module and retire its source files after the vault option is gone.
  - Preserve Cavemem data and runtime behavior, historical specs, and unrelated cost-diagnosis references.
  - Completion is observable when both host generations expose neither command and Cavemem still evaluates without a vault-path option.
  - _Requirements: 7.5, 7.6, 7.7_
  - _Boundary: Prompt Contract Cutover: Vault Pipeline_
  - _Depends: 3.1_

- [x] 3.5 (P) Convert common specialist prompts
  - Replace vault paths and writes in the scoped common specialists with AgentMemory search and save behavior.
  - Emit searchable memory handoffs where a specialist previously returned a note path.
  - Preserve each specialist's source-code permission posture and non-memory output contract.
  - Completion is observable when common specialist tests and rendered prompts contain AgentMemory handoffs and no Obsidian operation or vault path.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - _Boundary: Prompt Contract Cutover: Common Specialists_
  - _Depends: 2_

- [x] 3.6 (P) Convert context-budget memory profiles
  - Replace the canonical memory fragment and mirrored plugin text with AgentMemory-only discovery, recall, save, and operation-class guidance.
  - Remove vault role fragments, budgets, profiles, and smoke entries while preserving source and plugin mirror invariants.
  - Completion is observable when every context-budget unit and catalog test passes and no vault-only role resolves from a profile or smoke catalog.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - _Boundary: Prompt Contract Cutover: Context Budget_
  - _Depends: 2_

- [ ] 3.7 (P) Convert Shopify agent memory contracts
  - Replace Obsidian recall, note writes, vault references, and path outputs in the scoped Shopify agent prompts.
  - Emit `MEMORY_ID` plus a distinctive `MEMORY_QUERY`; consuming agents recall by query and verify the returned ID.
  - Preserve non-memory analysis artifacts, Quick handoffs, and read-only or source-mutation constraints.
  - Completion is observable when agent contract tests prove searchable handoffs and no scoped agent requires Obsidian or a vault path.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - _Boundary: Prompt Contract Cutover: Shopify Agents_
  - _Depends: 2_

- [ ] 3.8 Align Shopify skills and host prompt wiring
  - Convert the two memory-aware skills to AgentMemory recall and save behavior with the ID-plus-query handoff.
  - Remove host transformations that retained Obsidian and load the revised agent and skill sources directly.
  - Completion is observable when Shopify render tests use the revised sources, preserve skill and agent registration, and contain no active Obsidian workflow.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - _Boundary: Prompt Contract Cutover: Shopify Wiring_
  - _Depends: 3.7_

- [ ] 4. Integrate and validate the cutover
- [ ] 4.1 Build the isolated importer integration harness
  - Stage temporary vault fixtures, a fake Keychain helper, and a mock authenticated import endpoint without reading the real vault.
  - Add explicit daemon process ownership, authenticated health and readiness waits, bounded teardown, and isolated data and port paths for packaged-daemon tests.
  - Completion is observable when setup and teardown tests prove no orphan process, port, secret, or persistent target data remains after success and failure.
  - _Requirements: 1.5, 3.2, 3.3, 3.11_
  - _Boundary: Importer and Managed Command Integration: Harness_
  - _Depends: 1.4, 2_

- [ ] 4.2 Prove packaged import, rerun, and recall behavior
  - Exercise the packaged wrapper against the mock endpoint for secret redaction, exact response counts, partial failures, and exit status.
  - Import a fixture into the isolated packaged AgentMemory daemon, wait for index readiness, and recall its title, body, source file, and provenance concept.
  - Rerun after changing same-path content and prove the existing memory remains unchanged; prove a renamed path receives a new identity.
  - Completion is observable when mock and real-daemon tests pass for dry-run, live import, skip rerun, changed content, rename, and recall with source bytes unchanged.
  - _Requirements: 1.3, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - _Boundary: Importer and Managed Command Integration: Behavior_
  - _Depends: 4.1_

- [ ] 4.3 Reconcile host and MCP runtime matrices
  - Update AgentMemory and MCP inventory matrices for importer presence and removal of the Obsidian option, package, server, and dependent pipelines.
  - Validate the config-generation reload contract and start an isolated mcpproxy from the refreshed runtime copy to inspect live inventory without restarting the managed host service.
  - Preserve unrelated servers, both host evaluations, and the desktop cask assertion.
  - Completion is observable when both host matrices and isolated runtime inventory pass after packaged import and recall have been proven.
  - _Requirements: 3.1, 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Boundary: Cross-Boundary Integration: Runtime_
  - _Depends: 3.1, 3.4, 4.2_

- [ ] 4.4 (P) Reconcile startup and prompt integration checks
  - Update OpenCode and Pi matrices for the shortened preflight and retained AgentMemory failure behavior.
  - Add active-artifact checks across global, common, context-budget, Shopify agent, and skill renders while excluding historical specs.
  - Verify producer and consumer prompts emit, search, and ID-check `MEMORY_ID` plus `MEMORY_QUERY` handoffs.
  - Completion is observable when startup and active-prompt aggregate checks pass with no Obsidian operation, vault path, curator, synthesizer, or memory-sync exposure.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - _Boundary: Cross-Boundary Integration: Startup and Prompts_
  - _Depends: 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 4.2_

- [ ] 4.5 Wire and run focused feature validation
  - Register the new importer and aggregate cutover checks after obsolete memory-sync check wiring is removed.
  - Run importer unit and integration tests, both host matrices, isolated MCP inventory, OpenCode and Pi preflight, and prompt and catalog contracts.
  - Completion is observable when every focused check passes without adding source-vault deletion, desktop-cask removal, a rollback drill, or cross-host coordination.
  - _Requirements: 3.10, 3.11, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - _Boundary: Cross-Boundary Validation_
  - _Depends: 4.2, 4.3, 4.4_
