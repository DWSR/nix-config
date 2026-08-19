# Requirements Document

## Introduction
`pi-agent-integration` adds a direct, declaratively managed Pi environment to
both nix-darwin hosts. See `brief.md` for the problem, selected approach, and
scope decisions.

## Boundary Context
- **In scope**: managed Pi launches, host-specific providers, sandbox profiles,
  mcpproxy, Cavemem capture, sub-agents, plan mode, timestamps, Bash timeout,
  user questions, code intelligence, and background tasks on both hosts.
- **Out of scope**: Sieve, exact `devx pi` parity, private Shopify extension
  source, Pi self-updates, changes to mcpproxy or Cavemem storage/MCP APIs,
  adversarial isolation among managed Pi extensions, immutable provider-tool
  payload enforcement, and crash-atomic plan-state transitions.
- **Adjacent expectations**: mcpproxy remains the only MCP entrypoint, Cavemem
  remains the session store, existing OpenCode launch behavior is unchanged,
  and the managed in-process Pi extension set is trusted.

## Requirements

### Requirement 1: Declarative availability on both hosts
**Objective:** As the operator, I want Pi installed through the host configuration, so that both Macs provide the same reproducible agent baseline.

#### Acceptance Criteria
1. When a Home Manager generation activates with Pi enabled, the Pi integration shall make a managed `pi` command available on that host.
2. When the managed command reports its version, the Pi integration shall report the version selected by the active host generation.
3. While Pi is enabled, the Pi integration shall provide the common managed capabilities on both supported hosts except for declared provider differences.
4. While Pi is disabled, the Pi integration shall not install the managed command, profiles, configuration fragments, or extensions.
5. If Pi is enabled on an unsupported system, the Pi integration shall fail evaluation with an actionable compatibility error.
6. The Pi integration shall prevent Pi from replacing its managed executable through a self-update operation.

### Requirement 2: Managed configuration and mutable-state preservation
**Objective:** As the operator, I want managed configuration injected at launch without taking ownership of all Pi state, so that declarative values and user-managed state can coexist.

#### Acceptance Criteria
1. When the managed command starts, the Pi integration shall apply the active generation's managed settings and provider values before Pi reads them.
2. When managed values are applied, the Pi integration shall preserve unrelated user settings, provider entries, credentials, project-trust decisions, package entries, and session data.
3. When a value previously owned by the Pi integration is removed from host configuration, the Pi integration shall remove that value without removing an unrelated value at the same configuration level.
4. While two managed Pi launches start concurrently, the Pi integration shall keep every affected configuration file valid and shall apply one complete managed generation.
5. If an existing configuration file is invalid, the Pi integration shall stop before launching Pi and identify the file and corrective action.
6. While Home Manager activation runs, the Pi integration shall not mutate Pi's mutable runtime state.
7. The Pi integration shall not place provider credential values in declarative configuration files.

### Requirement 3: Host-specific provider behavior
**Objective:** As the operator, I want each host to use its intended provider environment, so that personal and Shopify credentials and routing never cross host boundaries.

#### Acceptance Criteria
1. When Pi launches on `ShopifyLaptop`, the Pi integration shall resolve the configured Shopify gateway endpoint and a valid short-lived credential before the first provider request.
2. When Pi launches on `ShopifyLaptop`, the Pi integration shall make the host-declared provider and model catalog available with its configured default model and request headers.
3. If Shopify gateway resolution fails or exceeds its launch timeout, the Pi integration shall stop before opening Pi and identify the failed gateway operation.
4. When Pi launches on the personal host, the Pi integration shall not invoke Shopify tooling, expose Shopify providers, or read Shopify credentials.
5. When Pi launches on the personal host, the Pi integration shall expose the managed OpenAI default and resolve its credential only from Pi's personal authentication state.
6. If user-managed authentication would override a managed host provider unexpectedly, the Pi integration shall stop and name the conflicting provider entry.
7. The Pi integration shall not write resolved credentials to generated files, logs, session records, or the Nix store.

### Requirement 4: Managed launch and preflight behavior
**Objective:** As the operator, I want launch failures detected before entering the TUI, so that Pi never starts with silently degraded required integrations.

#### Acceptance Criteria
1. When the managed command starts, the Pi integration shall validate its package, managed configuration, required extensions, selected sandbox state, mcpproxy, and Cavemem prerequisites before opening Pi.
2. If a required preflight check fails, the Pi integration shall exit non-zero and name the failed component and recovery action.
3. When all preflight checks pass, the Pi integration shall launch the direct managed Pi executable exactly once.
4. When the operator requests managed status, the Pi integration shall report the Pi version, host provider mode, sandbox state, active profile, mcpproxy endpoint, Cavemem state, and required extension versions without revealing secrets.
5. If a launch override is invalid, the Pi integration shall stop and list the accepted values.

### Requirement 5: Pi-specific nono sandbox profiles
**Objective:** As the operator, I want Pi launched under named sandbox postures, so that normal coding, compatibility diagnosis, and read-only review have explicit boundaries.

#### Acceptance Criteria
1. The Pi integration shall provide named profiles for managed coding, compatibility audit, and read-only review workflows.
2. When a managed profile is selected, the Pi integration shall launch Pi under that profile and report the effective sandbox state.
3. When the review profile is selected, the Pi integration shall prevent workspace writes and model-invoked command execution.
4. When the audit profile is selected, the Pi integration shall preserve required Pi workflows while exposing the profile identity to the operator.
5. When the operator supplies a per-launch sandbox override, the Pi integration shall apply it without requiring a host rebuild.
6. If nono or the selected profile is unavailable while sandboxing is requested, the Pi integration shall refuse to launch Pi unsandboxed.
7. If a selected profile blocks a required provider, mcpproxy, Cavemem, language-server, sub-agent, or background-task capability, the Pi integration shall fail with an actionable error.
8. The Pi integration shall provide an explicit documented rollback launch that bypasses sandbox enforcement.
9. The Pi integration shall not include provider credentials or MCP secrets in a sandbox profile.

### Requirement 6: mcpproxy as the sole MCP entrypoint
**Objective:** As the operator, I want Pi to use the existing local MCP gateway, so that both agents share one governed upstream inventory.

#### Acceptance Criteria
1. When Pi starts on either host, the Pi integration shall register exactly one managed remote MCP server pointing to that host's local mcpproxy endpoint.
2. When the MCP extension loads, the Pi integration shall expose only the approved direct mcpproxy discovery and invocation tools.
3. The Pi integration shall not expose an additional generic MCP proxy tool, script-execution tool, direct Cavemem server, or direct Shopify Tool Gateway server.
4. When Pi invokes an approved mcpproxy read operation, the Pi integration shall return the selected upstream result through the discover-then-invoke flow.
5. When Pi invokes `call_tool_write` or `call_tool_destructive`, the Pi integration shall require the configured explicit approval before forwarding it.
6. If mcpproxy or a mandatory upstream is unavailable during preflight, the Pi integration shall refuse to launch Pi and identify the unavailable service.
7. When Pi invokes `call_tool_read`, the Pi integration shall rely on mcpproxy's routing decision without an additional target-effect approval gate.

### Requirement 7: Declarative required-extension inventory
**Objective:** As the operator, I want one reviewed extension inventory on both hosts, so that Pi capabilities do not depend on mutable package installation.

#### Acceptance Criteria
1. The Pi integration shall provide the approved MCP, sub-agent, plan-mode, Cavemem, timestamp, Bash-timeout, user-question, code-intelligence, and background-task extensions on both hosts.
2. When Pi starts, the Pi integration shall load every required extension from a version-pinned managed source.
3. If a required extension is missing, fails to load, or is incompatible with the managed Pi version, the Pi integration shall stop before accepting a prompt and identify the extension.
4. The Pi integration shall not require `pi install`, `/pkg`, or another networked package mutation to make a required extension available.
5. The Pi integration shall disable extension install telemetry and unmanaged extension updates.
6. The Pi integration shall not load Sieve or another tool-output compressor as part of this feature.

### Requirement 8: Sub-agent workflows
**Objective:** As the operator, I want Pi to delegate bounded work to child agents, so that independent research and implementation work can run with isolated context.

#### Acceptance Criteria
1. When Pi delegates a single sub-agent task, the Pi integration shall run it in a distinct child session and return its result to the parent.
2. When Pi delegates independent sub-agent tasks in parallel, the Pi integration shall preserve each task's result and failure independently.
3. When a sub-agent chain is requested, the Pi integration shall pass only the declared predecessor output to the next child.
4. While a child agent runs, the Pi integration shall limit it to the declared tools, extensions, model budget, and workspace access.
5. The Pi integration shall prevent a child agent from recursively loading the sub-agent controller.
6. When a child produces an artifact, the Pi integration shall retain it within the owning parent session's state.
7. When a child is cancelled or the parent session exits, the Pi integration shall terminate the registered child process group, including ordinary descendants that remain in that group.
8. The Pi integration shall expose only the managed `reader` and `worker` child roles and shall reject call-level overrides of their model, budget, tools, workspace, extensions, MCP access, depth, output, or agent scope.

### Requirement 9: Read-only plan mode
**Objective:** As the operator, I want a guarded planning state before implementation, so that Pi can investigate and propose work before implementation actions are allowed.

#### Acceptance Criteria
1. When the operator enters plan mode, the Pi integration shall select the managed read-only discovery and plan-interaction tool names that are registered for the session.
2. While plan mode is active, the Pi integration shall block each model-requested tool call outside the managed planning allowlist before invoking that tool.
3. If Pi makes a non-allowlisted tool visible while plan mode is active, the Pi integration shall continue to block that tool's execution and shall report the denial.
4. When Pi completes a plan, the Pi integration shall present the plan for operator approval before restoring implementation tools.
5. When the operator exits, cancels, or approves plan mode, the Pi integration shall restore the captured ordered pre-plan tool names that remain registered and shall report unavailable names.
6. When a plan-mode session resumes with valid recorded state, the Pi integration shall restore the recorded workflow mode and captured pre-plan tool names.
7. If recorded plan-mode state is unavailable or invalid during resume, the Pi integration shall start in normal mode and report that the state was not restored.

### Requirement 10: Cavemem ambient capture
**Objective:** As the operator, I want Pi sessions captured by the existing memory system, so that Pi activity is searchable alongside OpenCode activity.

#### Acceptance Criteria
1. When a Pi session starts, the Pi integration shall record a Pi-identified session in the configured Cavemem data store.
2. When the operator submits a prompt, the Pi integration shall record the non-empty prompt against the active Pi session.
3. When a tool succeeds or fails, the Pi integration shall record the complete Pi-exposed input and output or error before later extension mutation, after secret and private-content redaction, up to the active SQLite maximum value length.
4. When an assistant turn or Pi session ends, the Pi integration shall flush the corresponding completion or shutdown event.
5. When a Pi session resumes, the Pi integration shall continue capture under the correct session identity.
6. If a capture event fails, the Pi integration shall surface the failure during the active session rather than silently discard it.
7. When the operator searches Cavemem through mcpproxy, the Pi integration shall make the captured Pi session and events discoverable from the existing data store.
8. The Pi integration shall not create a second Cavemem database or direct Pi MCP registration.
9. When the Pi bridge requests full-payload capture, the Pi integration shall bypass Cavemem tool-payload truncation and grammar compression for that event.
10. While existing non-Pi integrations use the default Cavemem hook path, the Pi integration shall preserve their current capture behavior.
11. If a redacted Pi payload exceeds the active SQLite maximum value length, the Pi integration shall reject it without storing a partial observation and shall surface the storage limit.

### Requirement 11: Interactive session aids
**Objective:** As the operator, I want consistent timing and interaction controls, so that long-running commands and clarification loops remain visible and bounded.

#### Acceptance Criteria
1. When the operator submits a prompt or receives an assistant response, the Pi integration shall display its local timestamp without adding timestamp text to model context.
2. When a session reloads or resumes, the Pi integration shall preserve previously recorded display timestamps.
3. When Pi invokes Bash without an explicit timeout, the Pi integration shall apply the declarative `bashDefaultMs` value after converting milliseconds to seconds, and mutable Supi settings shall not override it.
4. When Pi invokes Bash with an explicit timeout, the Pi integration shall preserve that value.
5. When the default or explicit Bash timeout expires, the Pi integration shall terminate the Bash process group, including ordinary descendants that remain in that group, and report a timeout result.
6. When Pi needs operator input outside plan mode, the Pi integration shall support structured choice, multiple-choice, and free-text questions.
7. When the operator cancels an active question, the Pi integration shall cancel the active turn without fabricating an answer.

### Requirement 12: Code intelligence
**Objective:** As the operator, I want language-aware repository navigation, so that Pi can inspect and change code with precise symbol information.

#### Acceptance Criteria
1. When a configured language server is available for the active repository, the Pi integration shall report it as ready.
2. When Pi requests symbol inspection, the Pi integration shall return definitions, references, implementations, hover information, symbols, or diagnostics with source locations as applicable.
3. When Pi requests a refactor, the Pi integration shall provide a no-write preview before an apply operation is available.
4. While plan mode or the review sandbox profile is active, the Pi integration shall prevent refactor apply operations from executing.
5. If a required language server fails to start, the Pi integration shall identify the server and failure without terminating unrelated Pi capabilities.
6. When the Pi session ends, the Pi integration shall terminate its language-server processes.

### Requirement 13: Managed background tasks
**Objective:** As the operator, I want Pi to supervise long-running commands, so that builds and servers can run concurrently without escaping session control.

#### Acceptance Criteria
1. When Pi starts a background task, the Pi integration shall return a stable task identifier and expose status, bounded logs, wait, input, and termination operations.
2. When Pi starts independent background tasks, the Pi integration shall run them concurrently while preserving deterministic event order within each task.
3. When Pi starts an interactive background task, the Pi integration shall support attach, detach, input, and signal operations.
4. When a background task exceeds its configured output limit, the Pi integration shall retain bounded operator-accessible output and report truncation.
5. When Pi terminates a background task, the Pi integration shall terminate the full process group and report the final state.
6. When the owning session exits, the Pi integration shall terminate all remaining background tasks and leave no orphan process.
7. While plan mode or the review sandbox profile is active, the Pi integration shall prevent background tasks from starting.

### Requirement 14: Credential and process isolation
**Objective:** As the operator, I want runtime credentials constrained to provider use, so that model-invoked tools do not receive secret material unnecessarily.

#### Acceptance Criteria
1. The Pi integration shall keep provider credential values out of the environment inherited by Bash commands, background tasks, Cavemem hooks, and language servers.
2. Where a child Pi process requires provider access, the Pi integration shall resolve credentials through the same host-specific provider contract without persisting them.
3. The Pi integration shall keep personal and Shopify credentials in separate host-specific state.
4. If a diagnostic or status command prints provider configuration, the Pi integration shall redact credential values and credential-bearing headers.
5. When a managed subprocess exits, the Pi integration shall not leave a credential-bearing temporary file behind.

### Requirement 15: Release safety and acceptance evidence
**Objective:** As the operator, I want dependency and integration gates before rollout, so that both hosts receive a compatible and supportable Pi environment.

#### Acceptance Criteria
1. If a selected production dependency closure contains a known critical or high-severity advisory without an explicit approved exception, the Pi integration shall reject that release.
2. When managed release validation runs, the Pi integration shall verify recovery from an incomplete context-limit response.
3. When repository checks run, the Pi integration shall evaluate both host configurations and validate managed configuration, profiles, wrappers, extension inventory, and license notices.
4. When integration smoke tests run, the Pi integration shall cover provider startup, mcpproxy invocation, sandbox enforcement, sub-agents, plan mode, Cavemem capture, timestamps, Bash timeout, user questions, code intelligence, and background-task cleanup.
5. If a compatibility or security gate fails, the Pi integration shall prevent rollout and identify the failed gate.
6. The Pi integration shall keep private Shopify source and runtime secrets out of publishable Nix closures.
7. The Pi integration shall provide operator guidance for provider setup, sandbox selection, launch overrides, status inspection, configuration recovery, extension updates, and rollback.
