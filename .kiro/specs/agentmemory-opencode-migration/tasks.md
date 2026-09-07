# Implementation Plan

- [ ] 1. Package and run standard AgentMemory
- [ ] 1.1 Pin the AgentMemory dependency closure
  - Lock AgentMemory `e04ba888`, Node dependencies, and iii-engine v0.11.2 for both Darwin systems.
  - Retain upstream OpenCode/Pi integration sources, metadata, commands, and licenses.
  - Unsupported systems fail evaluation with the selected revisions.
  - Both Darwin package outputs build reproducibly.
  - _Requirements: 1.1, 1.5, 7.3_
  - _Boundary: Package_

- [ ] 1.2 Build the standard runtime package
  - Package AgentMemory's daemon, stock MCP shim, and compatible iii binary without imperative downloads.
  - Preserve upstream start, stop, storage, indexing, fallback, and consolidation behavior.
  - Keep all service endpoints configurable and loopback by default.
  - The package starts, reports healthy, and stops through stock commands.
  - _Requirements: 1.1, 6.1, 6.7, 7.4_
  - _Boundary: Package_

- [ ] 1.3 Patch the existing upstream OpenCode plugin
  - Apply one provenance-labelled patch to `plugin/opencode/agentmemory-capture.ts` without changing its filename or named export.
  - Correct current event names and add completed assistant, reasoning, tool-state, idle, and dispose capture.
  - Retain stock REST calls, timeouts, automatic context, compression, and unaffected hooks.
  - Plugin tests show the patched upstream entrypoint emits the expected standard requests.
  - _Requirements: 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8_
  - _Boundary: ExistingPluginPatch_

- [ ] 1.4 Add the basic Home Manager runtime module
  - Define enablement, package, managed paths, ports, bearer reference, and backup destination options.
  - Render AgentMemory settings and launchd service without running `connect opencode`.
  - Remove all files and services when disabled.
  - Module tests show deterministic enabled and disabled output.
  - _Requirements: 1.2, 1.3, 1.6, 1.7, 6.1, 6.2_
  - _Boundary: AgentMemoryModule_

- [ ] 1.5 Add basic health and status checks
  - Report daemon health, selected revisions, managed data path, and listener state without revealing the bearer.
  - Distinguish healthy, stopped, and failed startup states.
  - Use stock process behavior rather than orphan cleanup or memory monitoring.
  - Status tests produce one actionable result for each state.
  - _Requirements: 3.4, 3.5, 6.4, 6.7_
  - _Boundary: AgentMemoryModule_

- [ ] 2. Connect AgentMemory to OpenCode
- [ ] 2.1 Install the existing plugin exactly once
  - Materialize the patched upstream entrypoint under OpenCode's managed plugin directory.
  - Preserve its filename, named export, metadata, license, revision, and patch provenance.
  - Do not add a duplicate plugin setting or invoke the AgentMemory connector.
  - Render tests show one loaded AgentMemory OpenCode plugin.
  - _Requirements: 1.3, 1.4, 1.5, 1.6_
  - _Boundary: AgentMemoryModule, ExistingPluginPatch_

- [ ] 2.2 Register the stock core MCP tools through mcpproxy
  - Register `@agentmemory/mcp` in core-tool mode as an mcpproxy upstream.
  - Keep mcpproxy as OpenCode's only configured MCP endpoint.
  - Preserve stock fallback and apply normal mcpproxy policy to write operations.
  - Inventory tests show the expected core tools and no direct OpenCode AgentMemory MCP entry.
  - _Requirements: 3.1, 3.2, 3.3, 3.6_
  - _Boundary: StockMcpIntegration_

- [ ] 2.3 Wire preflight, bearer, and nono access
  - Load the standard bearer into the OpenCode process and AgentMemory MCP shim through existing secret plumbing.
  - Allow OpenCode's sandbox to reach the loopback REST endpoint without granting the data directory.
  - Require full-daemon health during startup and preserve the independent Obsidian check.
  - Failed preflight stops OpenCode with one recovery action; success prints no secret.
  - _Requirements: 3.4, 3.5, 6.1, 6.2, 6.3, 6.4, 6.8_
  - _Boundary: AgentMemoryModule, StockMcpIntegration_

- [ ] 2.4 Verify standard plugin capture behavior
  - Exercise session start, prompt, assistant text, reasoning, tool success/failure, idle, and normal disposal.
  - Verify failed or timed-out REST calls are logged without a custom retry queue.
  - Confirm stored observations follow stock limits and compression.
  - The smoke session is discoverable through AgentMemory after OpenCode exits.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 2.8_
  - _Boundary: ExistingPluginPatch_

- [ ] 2.5 Update AgentMemory recall and context instructions
  - Describe stock AgentMemory discovery, recall, session, and save tools through mcpproxy.
  - Keep stock automatic context injection enabled and rely on the existing disabled title/summary agents.
  - Remove strict project, stable-context, and custom-fallback claims not provided by upstream.
  - Rendered instructions match the stock integration behavior.
  - _Requirements: 2.6, 3.3, 3.6, 3.7_
  - _Boundary: StockMcpIntegration, ConsumerCutover_

- [ ] 3. Import history and simplify consumers
- [ ] 3.1 Read and filter a cavemem snapshot
  - Create a SQLite Online Backup snapshot without modifying cavemem.
  - Select non-importer sessions and skip positive Pi and Obsidian-migration records.
  - Treat remaining unknown sessions as OpenCode history.
  - Dry-run output reports selected and skipped session, observation, and summary counts.
  - _Requirements: 4.1, 4.2, 4.3, 4.7_
  - _Boundary: BestEffortImporter_

- [ ] 3.2 Import bounded deterministic batches
  - Transform selected rows into AgentMemory's standard import shape.
  - Derive deterministic IDs and submit batches below 8 MiB with stock skip semantics.
  - Continue after malformed rows and independent failed batches where possible.
  - The final report lists imported, existing, skipped, malformed, and failed counts by record type.
  - _Requirements: 4.2, 4.4, 4.5, 4.6, 4.7, 4.8_
  - _Boundary: BestEffortImporter_

- [ ] 3.3 Remove cavemem augmentation from session compaction
  - Select normal OpenCode compaction without the cavemem search source under AgentMemory.
  - Leave compaction thresholds, manual command, and continuation behavior unchanged.
  - Retain the prior source in cavemem rollback mode.
  - Compaction tests pass in both backend selections.
  - _Requirements: 5.1, 5.2, 7.8_
  - _Boundary: ConsumerCutover_

- [ ] 3.4 Disable unported synthesis and sync consumers
  - Remove vault-synthesizer registration and memory-sync packaging in AgentMemory mode.
  - Preserve both features in cavemem rollback mode.
  - Keep manual Obsidian memory and vault-curator behavior unchanged.
  - Render tests show no automatic AgentMemory-to-Obsidian promotion.
  - _Requirements: 5.3, 5.5, 5.6, 7.8_
  - _Boundary: ConsumerCutover_

- [ ] 3.5 Split OpenCode ownership from current Pi cavemem
  - Gate cavemem's OpenCode plugin, preflight, instructions, and consumers behind the backend selector.
  - Retain the cavemem package, patches, settings, data, MCP upstream, and backup required by Pi.
  - Keep every Pi-owned implementation path unchanged.
  - Either backend renders one OpenCode capture plugin while Pi remains on cavemem.
  - _Requirements: 5.1, 5.4, 7.1, 7.2, 7.6, 7.8_
  - _Boundary: CavememBoundary, ConsumerCutover_

- [ ] 4. Add basic operations and host rollout
- [ ] 4.1 Add best-effort stopped-runtime backup
  - Invoke AgentMemory's stock stop path and wait for its known processes/listeners to exit within a fixed timeout.
  - Copy the complete managed data directory to the configured backup destination and restart the service.
  - Report stop, copy, and restart failures without claiming transactional consistency or restore validation.
  - Backup tests verify the command sequence and archived path inventory.
  - _Requirements: 6.5, 6.6, 6.7_
  - _Boundary: SimpleBackup_

- [ ] 4.2 Enable AgentMemory for OpenCode on both hosts
  - Import the module, select AgentMemory as OpenCode's backend, and configure managed paths and secret references.
  - Keep current Pi cavemem enabled on each host.
  - Enable simple backup only where a destination already exists.
  - Both host evaluations produce the same OpenCode behavior with declared host-specific values.
  - _Requirements: 1.7, 6.5, 7.1, 7.2, 7.7_
  - _Boundary: AgentMemoryModule, CavememBoundary_

- [ ] 4.3 Preserve an explicit cavemem rollback selection
  - Keep the backend selector capable of rendering the prior OpenCode cavemem plugin, checks, consumers, and instructions.
  - Avoid deleting or transforming source cavemem data during activation.
  - Document the retained generation as the rollback target in status output.
  - Rollback evaluation contains no AgentMemory OpenCode plugin or direct dependency.
  - _Requirements: 5.1, 7.7, 7.8_
  - _Boundary: CavememBoundary_

- [ ] 4.4 Register the focused host-render validation matrix
  - Evaluate AgentMemory enabled, disabled, personal, Shopify, and cavemem rollback configurations.
  - Inspect packages, plugin count, launchd, loopback endpoints, MCP topology, instructions, and consumer selection.
  - Scan generated files for literal bearer values and unintended Pi-path changes.
  - The matrix runs as one flake check.
  - _Requirements: 1.2, 1.6, 1.7, 3.2, 5.4, 6.1, 7.1, 7.2_
  - _Boundary: ValidationSuite_

- [ ] 5. Validate migration and compatibility
- [ ] 5.1 Validate daemon, capture, MCP, and automatic context end to end
  - Start the managed daemon and OpenCode, capture one prompt/assistant/tool session, and stop normally.
  - Recall the session through stock core MCP tools via mcpproxy.
  - Verify automatic context is present under stock plugin behavior and full-daemon preflight rejects startup failure.
  - The focused smoke flow passes on the supported host test environment.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.4, 3.5_
  - _Boundary: ValidationSuite_

- [ ] 5.2 Validate one-shot import and rerun behavior
  - Import a fixture with normal, unknown, Pi, importer, malformed, and failed-batch records.
  - Rerun the command and verify deterministic IDs are skipped rather than duplicated.
  - Compare source and report counts without testing crash recovery or rollback.
  - Imported records are searchable through stock AgentMemory tools.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_
  - _Boundary: ValidationSuite, BestEffortImporter_

- [ ] 5.3 Validate simplified consumer and Obsidian behavior
  - Run compaction without cavemem augmentation under AgentMemory.
  - Verify vault-synthesizer and memory-sync are absent while manual Obsidian memory and curator remain.
  - Render global and subagent instructions with no OpenCode cavemem direction.
  - Cavemem rollback restores the prior consumers and instructions.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - _Boundary: ValidationSuite, ConsumerCutover_

- [ ] 5.4 Run the unchanged current Pi cavemem suite
  - Execute existing Pi capture, recall, startup, resume, and shutdown tests unchanged.
  - Compare its cavemem package, patches, data path, MCP upstream, and backup with baseline.
  - Confirm AgentMemory host changes do not activate or configure Pi.
  - The Pi suite passes with no Pi-owned source changes.
  - _Requirements: 7.1, 7.2, 7.6_
  - _Boundary: ValidationSuite, CavememBoundary_

- [ ] 5.5 Validate future AgentMemory Pi plugin compatibility
  - Load the unchanged bundled Pi factory and security helper through the selected Pi extension API.
  - Mock standard authenticated health, session, observe, smart-search, remember, end, and consolidate responses.
  - Verify the packaged relative layout and expected request/response shapes.
  - Compatibility passes without Pi host wiring, credentials, or history migration.
  - _Requirements: 7.3, 7.4, 7.5, 7.6_
  - _Boundary: ValidationSuite, Package_

- [ ] 5.6 Validate cutover and rollback without dual writes
  - Start OpenCode under the AgentMemory backend and prove cavemem receives no new OpenCode capture.
  - Keep Pi cavemem active during the same validation.
  - Activate the rollback selection and capture one OpenCode cavemem event.
  - Both stores remain intact and no migration is reversed.
  - _Requirements: 7.1, 7.2, 7.7, 7.8_
  - _Boundary: ValidationSuite, CavememBoundary_
