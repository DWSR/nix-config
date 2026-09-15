# Brief: agentmemory-obsidian-migration

## Problem

OpenCode now uses AgentMemory for ambient and explicit memory, but curated
memories remain in an Obsidian vault. The harness still carries an Obsidian MCP
server, mandatory preflights, prompt instructions, and vault-only agents that
duplicate the active memory system and can block OpenCode when Obsidian is
unavailable.

## Current State

Both hosts run AgentMemory behind mcpproxy. Curated notes use
`memories/YYYY-MM-DD-<slug>.md` with YAML metadata and Markdown bodies.
Obsidian remains a base mcpproxy upstream, an OpenCode and Pi startup
dependency, and the target of global, subagent, skill, curator, synthesizer,
and memory-sync instructions.

## Desired Outcome

Existing `memories/*.md` notes are copied into each selected host-local
AgentMemory store through a one-shot command. AgentMemory becomes the only live
agent memory surface. Obsidian is absent from mcpproxy, startup checks, and
active agent prompts. The source vault and Obsidian desktop application remain
untouched.

## Approach

Package a small importer that accepts a vault path, reads regular Markdown
files directly under `memories/`, validates and maps them to AgentMemory memory
records, and sends bounded authenticated batches to `/agentmemory/import` with
deterministic `mem_` IDs and `strategy: "skip"`. Report malformed, oversized,
skipped, and imported records; rerunning is the only recovery mechanism.

After import capability exists, hard-remove the Obsidian MCP package and server
wiring, Obsidian preflights, vault-specific prompt contracts, and obsolete
curator/synthesizer/memory-sync exposure. Update active guidance to use
AgentMemory core tools through mcpproxy.

## Scope

- **In**: One-shot `memories/*.md` import; dry-run and concise result counts;
  deterministic reruns; both host-local AgentMemory targets; Obsidian MCP and
  package removal; OpenCode and Pi preflight removal; active prompt and agent
  cutover; retirement of Obsidian-dependent vault pipeline exposure; focused
  tests and supersession notes.
- **Out**: MOCs, archived conversations, attachments, nested notes,
  bidirectional sync, continuous watching, semantic deduplication, rollback,
  transaction journals, automatic crash resume, cross-host coordination,
  source-vault deletion, and Obsidian desktop application removal.

## Boundary Candidates

- Importer: note discovery, schema mapping, authenticated batching, and report.
- Runtime retirement: mcpproxy inventory, Nix options/packages, and preflights.
- Prompt cutover: global, Pi, subagent, skill, and generated instruction sources.
- Validation: importer fixtures, rendered host matrices, and stale-reference
  checks.

## Out of Boundary

- Reworking AgentMemory capture, recall, BM25 bounds, or consolidation.
- Preserving the Cavemem-to-Obsidian promotion pipeline.
- Rewriting historical completed specs; this spec records the contracts it
  supersedes.
- Repairing inherited iii-engine licensing packaging or runtime behavior.
- Redacting curated note bodies before local import.

## Upstream / Downstream

- **Upstream**: `agentmemory-opencode-migration`, AgentMemory `e04ba888`, the
  authenticated import endpoint, mcpproxy, Home Manager, and the existing
  Obsidian memory-note format.
- **Downstream**: AgentMemory recall/save guidance, OpenCode and Pi startup, and
  agents that currently create durable Obsidian notes.

## Existing Spec Touchpoints

- **Extends**: none.
- **Adjacent**: `agentmemory-opencode-migration`, `mcpproxy-migration`,
  `cavemem-integration`, `vault-synthesizer-agent`, `memory-sync-cli`,
  `cc-sdd-integration`, and `subagent-context-budget`.
- **Supersedes**: Prior requirements that preserve Obsidian as a mandatory MCP,
  startup gate, manual memory surface, or Cavemem promotion target.

## Constraints

- Keep mcpproxy as OpenCode's only MCP endpoint and use AgentMemory's stock core
  tools for future recall and saves.
- Import only regular files whose resolved paths remain under
  `<vault>/memories`; do not follow symlinks outside that directory.
- Use the import envelope required by the pinned AgentMemory version. Validate
  complete memory records before sending them, keep batches below 50,000
  records and 8 MiB, and require both HTTP success and `success: true`.
- Derive stable IDs from normalized vault-relative paths. `strategy: "skip"`
  provides rerun safety, not content reconciliation.
- Preserve note content locally and accept AgentMemory's normal indexing,
  recall projection, and auto-forget/consolidation behavior.
- Migration runs independently on each desired host. No activation-time import
  or cross-host completion gate is required.
