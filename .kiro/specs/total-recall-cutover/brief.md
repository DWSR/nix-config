# Brief: total-recall-cutover

## Problem
Original request, verbatim:
> Create a spec to implement https://github.com/DWSR/total-recall as the agent memory system, replacing agentmemory and Obsidian. Do not require an import, do a hard cut and assume backfill will not happen.

The operator wants one active memory system for OpenCode and Pi on the currently exported personal `Brandons-MacBook-Pro`.

## Current State
Home Manager enables AgentMemory, OpenCode capture, Pi capture and a private Pi bearer artifact. AgentMemory is exposed through mcpproxy; its Obsidian importer remains installed. The Obsidian agent integration and Cavemem runtime were already retired; historical stores/specs remain.

Total Recall research baseline `7f9ac6628c33e0fa5212e818cec56495e4d51038` exports native workers and harness adapters but lacks the required conventional MCP, ambient startup context for both harnesses, and ChatGPT/Codex OAuth postprocessing support. It is not a deployable pin.

## Desired Outcome
Both harnesses capture new sessions, use explicit Total Recall memory tools through mcpproxy, and receive upstream ambient startup context. A fresh empty store becomes the sole active memory backend after compatibility gates pass.

## Approach
Confirmed new single feature: native Nix-managed deployment using upstream contracts, PostgreSQL, iii and supporting workers. Deploy only compatible immutable artifacts after upstream prerequisites are delivered. Use existing oMLX embeddings and dedicated Total Recall OpenAI OAuth postprocessing credentials.

## Scope
- **In**: Native packaging/configuration, launchd supervision, database lifecycle, queue/reconciliation, both adapters, MCP wiring/result fidelity, runtime secrets, active prompt/launcher/sandbox updates and retirement of AgentMemory consumers/importer.
- **Out**: Imports, backfill, dual-write, old-backend fallback, deletion of historical stores/vaults, removal of Obsidian desktop, backups, cross-host rollout and graph features.

## Boundary Candidates
- Upstream Total Recall: conventional MCP interoperability, full capture and startup context adapters, dedicated OAuth provider/login/refresh and processing model compatibility.
- nix-config: immutable packages, native service lifecycle, managed configuration/secrets references, mcpproxy routing, existing Pi bridge result handling and cutover acceptance.

## Out of Boundary
No local protocol facade, capture/context relay, OAuth shim or new remote iii event bridge. Upstream prerequisite delivery is an external dependency, not implementation work owned by this spec.

## Upstream / Downstream
- **Upstream**: Compatible Total Recall and iii artifacts; PostgreSQL extensions; actual managed harness runtimes; existing oMLX service and generic secrets bridge.
- **Downstream**: OpenCode/Pi memory consumers and agent instructions; no additional migration or backfill workstream.

## Existing Spec Touchpoints
- **Extends**: None; this is a new spec with a distinct hard-cut boundary.
- **Supersedes upon cutover**: Active memory behavior from `agentmemory-opencode-migration`, `agentmemory-obsidian-migration`, `cavemem-integration`, `vault-synthesizer-agent` and `memory-sync-cli`. Preserve their historical documents.
- **Adjacent**: `omlx-service`, `mcpproxy-migration`, `mcp-secrets-sops-nix`, `opencode-nono-sandbox`, `opencode-nono-audit`, `subagent-context-budget` and `session-compaction`.

## Constraints
- Adopt documented upstream delivery semantics: require evidence of retries, possible duplicates, loss windows and recovery limits; no exactly-once guarantee, additional upstream dedup feature or local dedup implementation.
- Both capture and ambient startup context are mandatory before cutover; no partial harness rollout.
- U1 proves conventional worker-to-managed-mcpproxy protocol and payload fidelity; adapter contracts belong to U2. Model-facing rendering is local post-implementation evidence in tasks 9/14/15, not a U1 prerequisite.
- Same-generation memory availability uses a generation admission marker and failure containment, not atomic OS activation or atomic replacement of both configuration files. Incomplete activation disables memory while ordinary harness work remains fail-open; later published-generation outages retain the marker.
- Embeddings: existing `Qwen3-Embedding-0.6B-4bit-DWQ` through oMLX on loopback port 8000, using runtime Keychain `mcpproxy/omlx-api-key`.
- Postprocessing: OpenAI ChatGPT/Codex OAuth with a dedicated Total Recall login/credential owner. Exact processing model remains an unresolved blocking upstream-gate decision; no API-key substitution or reuse of harness auth.
- Credentials never enter the Nix store. Bind local listeners to `127.0.0.1`; the iii bus is a trusted-local-user boundary, not authenticated subprocess isolation.
- Runtime capture/startup context fail open during service/inference outages, with no old fallback. Managed-launch configuration checks may run without speculative inference liveness hard failures.
- Preserve generic mcpproxy/quarantine, nono audit mode, unrelated ports/plugins/MCPs, disabled OpenCode title/summary agents, native session compaction and Obsidian desktop.
- Model selection, compatible immutable artifacts and compatibility evidence are operator provisioning recorded in design.md, not implementation tasks. Their absence blocks cutover authorization, not secret-independent implementation; normal phase approvals govern `ready_for_implementation`.
- The user conditionally approved the design and requested a task plan with operator provisioning. This approval clears no cutover gate; candidate contract revisit, renewed design approval and task approval precede task 1.
