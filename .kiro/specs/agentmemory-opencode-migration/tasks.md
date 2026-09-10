# Implementation Plan

- [x] 1. Package and run bounded AgentMemory
- [x] 1.1 Pin the AgentMemory dependency closure
  - Lock AgentMemory `e04ba888`, Node dependencies, and iii-engine v0.11.2 for both Darwin systems.
  - Retain upstream OpenCode integration sources, metadata, commands, and licenses.
  - Unsupported systems fail evaluation with the selected revisions.
  - Both Darwin package outputs build reproducibly.
  - _Requirements: 1.1, 1.5_
  - _Boundary: Package_

- [x] 1.2 Build the standard runtime package
  - Package AgentMemory's daemon, stock MCP shim, and compatible iii binary without imperative downloads.
  - Preserve upstream start, stop, storage, fallback, and consolidation behavior while applying the approved BM25 bounds.
  - Keep all service endpoints configurable and loopback by default.
  - The package starts, reports healthy, and stops through stock commands.
  - _Requirements: 1.1, 2.9, 2.10, 6.1, 6.7_
  - _Boundary: Package_

- [x] 1.3 Patch the existing upstream OpenCode plugin
  - Apply one provenance-labelled patch to `plugin/opencode/agentmemory-capture.ts` without changing its filename or named export.
  - Correct current event names and add completed assistant, reasoning, tool-state, idle, and dispose capture.
  - Retain stock REST calls, timeouts, automatic context, compression, and unaffected hooks.
  - Plugin tests show the patched upstream entrypoint emits the expected standard requests.
  - _Requirements: 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8_
  - _Boundary: ExistingPluginPatch_

- [x] 1.4 Add the basic Home Manager runtime module
  - Define enablement, package, managed paths, ports, bearer, BM25 bounds, and backup destination options.
  - Render AgentMemory settings and launchd service without running `connect opencode`.
  - Remove all files and services when disabled.
  - Module tests show deterministic enabled and disabled output.
  - _Requirements: 1.2, 1.3, 1.6, 1.7, 6.1, 6.2_
  - _Boundary: AgentMemoryModule_

- [x] 1.5 Add basic health and status checks
  - Report daemon health, selected revisions, managed data path, and listener state without revealing the bearer.
  - Distinguish healthy, degraded, stopped, and failed startup states with an authenticated probe.
  - Install Keychain-backed wrappers for managed `agentmemory` and `agentmemory-status` commands.
  - Use stock process behavior rather than orphan cleanup or memory monitoring.
  - Status tests produce one actionable result for each state.
  - _Requirements: 3.4, 3.5, 6.4, 6.7, 6.9_
  - _Boundary: AgentMemoryModule_

- [x] 2. Connect AgentMemory to OpenCode
- [x] 2.1 Install the existing plugin exactly once
  - Materialize the patched upstream entrypoint under OpenCode's managed plugin directory.
  - Preserve its filename, named export, metadata, license, revision, and patch provenance.
  - Do not add a duplicate plugin setting or invoke the AgentMemory connector.
  - Render tests show one loaded AgentMemory OpenCode plugin.
  - _Requirements: 1.3, 1.4, 1.5, 1.6_
  - _Boundary: AgentMemoryModule, ExistingPluginPatch_

- [x] 2.2 Register the stock core MCP tools through mcpproxy
  - Register `@agentmemory/mcp` in core-tool mode as an mcpproxy upstream.
  - Keep mcpproxy as OpenCode's only configured MCP endpoint.
  - Preserve stock fallback and apply normal mcpproxy policy to write operations.
  - Inventory tests show the expected core tools and no direct OpenCode AgentMemory MCP entry.
  - _Requirements: 3.1, 3.2, 3.3, 3.6_
  - _Boundary: StockMcpIntegration_

- [x] 2.3 Wire preflight, bearer, and nono access
  - Load the standard bearer into the OpenCode process and AgentMemory MCP shim through existing secret plumbing.
  - Allow OpenCode's sandbox to reach the loopback REST endpoint without granting the data directory.
  - Accept authenticated healthy/degraded full-daemon state and preserve the independent Obsidian check.
  - Failed preflight stops OpenCode with one recovery action; success prints no secret.
  - _Requirements: 3.4, 3.5, 6.1, 6.2, 6.3, 6.4, 6.8_
  - _Boundary: AgentMemoryModule, StockMcpIntegration_

- [x] 2.4 Verify standard plugin capture behavior
  - Exercise session start, prompt, assistant text, reasoning, tool success/failure, idle, and normal disposal.
  - Verify failed or timed-out REST calls are logged without a custom retry queue.
  - Confirm stored observations follow stock limits/compression and bounded BM25 semantics.
  - The smoke session is discoverable through AgentMemory after OpenCode exits.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9, 2.10_
  - _Boundary: ExistingPluginPatch_

- [x] 2.5 Update AgentMemory recall and context instructions
  - Describe stock AgentMemory discovery, recall, session, and save tools through mcpproxy.
  - Keep stock automatic context injection enabled and rely on the existing disabled title/summary agents.
  - Remove strict project, stable-context, and custom-fallback claims not provided by upstream.
  - Rendered instructions match the stock integration behavior.
  - _Requirements: 2.6, 3.3, 3.6, 3.7_
  - _Boundary: StockMcpIntegration, ConsumerCutover_

- [ ] 3. Import history and simplify consumers
- [x] 3.1 Read and filter a cavemem snapshot
  - Create a SQLite Online Backup snapshot without modifying cavemem.
  - Select OpenCode sessions and skip positive non-OpenCode/importer provenance.
  - Treat remaining unknown sessions as OpenCode history.
  - Dry-run output reports selected and skipped session, observation, and summary counts.
  - _Requirements: 4.1, 4.2, 4.3, 4.7_
  - _Boundary: BestEffortImporter_

- [x] 3.2 Import bounded deterministic batches
  - Transform selected rows into AgentMemory's standard import shape.
  - Derive deterministic IDs and submit batches below 8 MiB with stock skip semantics.
  - Run the native importer on Node 22, stream output, and prepare/size batches linearly.
  - Bake the configured AgentMemory REST endpoint into the packaged command.
  - Continue after malformed rows and independent failed batches where possible.
  - The final report lists imported, existing, skipped, malformed, and failed counts by record type.
  - _Requirements: 4.2, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11_
  - _Boundary: BestEffortImporter_

- [x] 3.3 Remove cavemem augmentation from session compaction
  - Force normal OpenCode compaction without the cavemem search source under AgentMemory.
  - Leave compaction thresholds, manual command, and continuation behavior unchanged.
  - Retain the prior source in cavemem rollback mode.
  - Compaction tests pass in both backend selections.
  - _Requirements: 5.1, 5.2, 7.2_
  - _Boundary: ConsumerCutover_

- [x] 3.4 Disable unported synthesis and sync consumers
  - Remove vault-synthesizer registration and memory-sync packaging in AgentMemory mode.
  - Preserve both features in cavemem rollback mode.
  - Keep manual Obsidian memory and vault-curator behavior unchanged.
  - Render tests show no automatic AgentMemory-to-Obsidian promotion.
  - _Requirements: 5.3, 5.5, 5.6, 7.2_
  - _Boundary: ConsumerCutover_

- [x] 3.5 Isolate OpenCode rollback ownership
  - Gate OpenCode cavemem rollback plugin, preflight, instructions, and consumers behind the backend selector.
  - Exclude Pi packages, configuration, credentials, behavior, and tests from the feature boundary.
  - Each backend renders one OpenCode capture plugin without evaluating Pi ownership.
  - _Requirements: 5.1, 5.4, 7.1, 7.4_
  - _Boundary: ConsumerCutover_

- [ ] 4. Add basic operations and host rollout
- [ ] 4.1 Add best-effort stopped-runtime backup
  - Suspend the launchd KeepAlive job before invoking stock stop and waiting for all known processes/listeners.
  - Copy the complete managed data directory to the configured backup destination and restart the service.
  - Restore launchd after the copy and report suspend, stop, copy, and restart failures.
  - Backup tests model KeepAlive restart pressure and verify the archived inventory.
  - _Requirements: 6.5, 6.6, 6.7_
  - _Boundary: SimpleBackup_

- [x] 4.2 Enable AgentMemory for OpenCode on both hosts
  - Import the module, select AgentMemory as OpenCode's backend, and configure managed paths and secret references.
  - Configure simple backup only where an AgentMemory destination exists.
  - Defer the personal encrypted bearer until personal activation without blocking evaluation.
  - Both host evaluations produce the same OpenCode behavior with declared host-specific values.
  - _Requirements: 1.7, 6.5, 6.10, 7.1_
  - _Boundary: AgentMemoryModule_

- [ ] 4.3 Preserve an explicit OpenCode cavemem rollback selection
  - Keep the backend selector capable of rendering the prior OpenCode cavemem plugin, checks, consumers, and instructions.
  - Make backend selection enable every required cavemem module contribution on each real host.
  - Avoid deleting or transforming source cavemem data during OpenCode rollback.
  - Document the retained OpenCode rollback generation in status output.
  - Rollback evaluation contains no AgentMemory OpenCode capture path.
  - _Requirements: 5.1, 7.1, 7.2, 7.3_
  - _Boundary: HostRollback_

- [ ] 4.4 Register the complete feature validation suite
  - Evaluate AgentMemory enabled, disabled, personal, Shopify, and OpenCode cavemem rollback configurations.
  - Inspect packages, plugin count, launchd, loopback endpoints, MCP topology, instructions, consumers, and rollback.
  - Register package, plugin, status, import, backup, host, and rollback tests under `nix flake check`.
  - Validate configured importer endpoint/bearer wiring while allowing the personal encrypted bearer to remain absent before activation.
  - Remove stale environment assertions and make test-local flake access independent of linked-worktree metadata.
  - _Requirements: 1.2, 1.6, 1.7, 3.2, 4.11, 5.4, 6.1, 6.10, 7.1, 7.2_
  - _Boundary: ValidationSuite_

- [ ] 5. Validate migration and rollback
- [x] 5.1 Validate daemon, capture, MCP, and automatic context end to end
  - Start the managed daemon and OpenCode, capture one prompt/assistant/tool session, and stop normally.
  - Recall the session through stock core MCP tools via mcpproxy.
  - Verify automatic context is present under stock plugin behavior and full-daemon preflight rejects startup failure.
  - The focused smoke flow passes on the supported host test environment.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.4, 3.5_
  - _Boundary: ValidationSuite_

- [x] 5.2 Validate one-shot import and rerun behavior
  - Import a fixture with normal, unknown, non-OpenCode, importer, malformed, and failed-batch records.
  - Rerun the command and verify deterministic IDs are skipped rather than duplicated.
  - Compare source and report counts without testing crash recovery or rollback.
  - Accepted records remain in KV; indexed records are searchable through AgentMemory tools.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.12_
  - _Boundary: ValidationSuite, BestEffortImporter_

- [ ] 5.3 Validate simplified consumer and Obsidian behavior
  - Run compaction without cavemem augmentation under AgentMemory.
  - Verify vault-synthesizer and memory-sync are absent while manual Obsidian memory and curator remain.
  - Render global and subagent instructions with no OpenCode cavemem direction.
  - Cavemem rollback restores the prior consumers and instructions.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - _Boundary: ValidationSuite, ConsumerCutover_

- [x] 5.4 Validate large-corpus operational bounds
  - Exercise BM25 FIFO capacity and persistence refusal without deleting KV observations.
  - Exercise Node 22 native importer ABI, streaming JSON, linear batch sizing, and progress.
  - The bounded daemon remains available after rebuilding the migrated corpus.
  - _Requirements: 2.9, 2.10, 4.9, 4.10, 4.12, 6.7_
  - _Boundary: ValidationSuite, OperationalBounds_

- [x] 5.5 Validate authenticated CLI and health behavior
  - Verify the managed CLI and status wrappers resolve the bearer without printing it.
  - Accept HTTP-200 healthy/degraded full-daemon responses and reject fallback/critical states.
  - _Requirements: 3.4, 3.5, 6.4, 6.9_
  - _Boundary: ValidationSuite, AgentMemoryModule_

- [ ] 5.6 Validate cutover and rollback without dual writes
  - Start OpenCode under AgentMemory and prove it does not write new ambient history to cavemem.
  - Activate each real host's rollback selection and capture one OpenCode cavemem event.
  - Both stores remain intact and no migration is reversed.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - _Boundary: ValidationSuite, HostRollback_

## Implementation Notes

- AgentMemory persists summaries by target session, so the importer merges all source summaries per session, retains source IDs and narratives in provenance, and reports source `selected` counts separately from target import counts.
- Pi is explicitly outside this specification. Pi findings do not affect this feature's validation decision.
- Pre-activation validation must prove the personal configuration tolerates absent bearer ciphertext without requiring the ciphertext itself.
