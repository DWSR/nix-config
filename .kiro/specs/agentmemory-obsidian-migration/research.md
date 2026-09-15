# Research and Gap Analysis

## Summary

- The hard cut is feasible with the pinned AgentMemory runtime.
- Import support exists for sessions, observations, and summaries, but no local
  code currently imports AgentMemory memory records from Markdown.
- Removal work spans one MCP module, two host values, OpenCode and Pi preflights,
  global/common/Shopify prompt sources, generated context-budget fragments, and
  their tests.
- The main risks are AgentMemory's permissive import route, runtime request-size
  limits, and stale Obsidian assumptions in generated prompt surfaces.
- No rollback or synchronization capability is required.

## Current Assets

### AgentMemory import path

- `scripts/agentmemory-import-cavemem.ts` already implements deterministic
  record preparation, dry-run reporting, bounded payloads, authenticated HTTP,
  `strategy: "skip"`, and response-body success validation.
- `scripts/agentmemory-import-cavemem.nix` resolves the managed Keychain bearer,
  sets the configured REST endpoint, and runs Node 22.
- `home-manager/common/agentmemory.nix` installs the importer on both enabled
  hosts and owns the AgentMemory endpoint and bearer reference.
- `tests/agentmemory-opencode/import-cavemem.test.js` provides mock-server and
  packaged-daemon test patterns.
- `scripts/cavemem-import-vault.js` contains Markdown frontmatter, YAML, date,
  stable-hash, and per-file error handling patterns. Its file walk follows
  symlinks and is not safe to reuse unchanged.

### Obsidian runtime dependencies

- `home-manager/mcp/default.nix` owns `baseServers.obsidian`,
  `home.mcp.obsidianVaultPath`, and `pkgs.mcp-obsidian` installation.
- `overlays/mcp-servers.nix` packages `mcp-obsidian`.
- `configurations/{personal,shopify}/home-manager/default.nix` provide vault
  paths.
- `home-manager/common/opencode.nix` checks the Obsidian upstream before the
  AgentMemory health gate.
- `scripts/pi-agent-status.nix` requires both `obsidian` and `agentmemory`.
- The mcpproxy daemon uses a private runtime copy of the Home Manager source
  config; source changes take effect only after managed runtime preparation and
  restart.

### Prompt and pipeline dependencies

- `home-manager/common/agents.md` is the global Obsidian recall/write contract.
- `home-manager/common/agents-agentmemory.md` still declares the dual-memory
  model.
- `home-manager/common/agents-cc-sdd.md` gives Obsidian precedence over Kiro
  steering.
- `home-manager/common/pi-agent/instructions.md` mandates an Obsidian startup
  call.
- `home-manager/common/agents/{vault-curator,vault-synthesizer}.md` define the
  obsolete vault pipeline; `home-manager/common/opencode.nix` registers curator
  on every backend and synthesizer for Cavemem.
- `scripts/memory-sync.nix` orchestrates those agents and probes Obsidian.
- `home-manager/common/subagent-context-budget/` stores Obsidian text in both
  Markdown fragments and `plugin.ts`; catalogs and tests reference both vault
  roles.
- `home-manager/common/agents/security-auditor.md` and Shopify Yugabyte agents
  and skills require durable Obsidian writes.

## Pinned AgentMemory Findings

- `/agentmemory/import` requires `{ exportData, strategy }`; `exportData` must
  include `version`, `sessions`, `observations`, `memories`, and `summaries`.
  [Pinned source](https://github.com/rohitg00/agentmemory/blob/e04ba88819c365c9acf9d6661ea802143e728bd6/src/functions/export-import.ts#L204-L249)
- The route does not validate each memory record before persistence. Local
  validation is required to avoid accepted but unindexable records.
  [Memory type](https://github.com/rohitg00/agentmemory/blob/e04ba88819c365c9acf9d6661ea802143e728bd6/src/types.ts#L102-L125)
- One request accepts at most 50,000 memories. iii rejects frames above 16 MiB;
  the existing importer uses a conservative payload ceiling below 8 MiB.
- Logical rejection can return HTTP 200. A caller must require
  `body.success === true` and validate returned counts.
- Bearer authentication uses `Authorization: Bearer <secret>`.
- `strategy: "skip"` compares IDs only. It does not reconcile changed content
  or perform semantic deduplication.
- Imported IDs should use the `mem_` namespace because later `memory_save`
  supersession expects indexed memory IDs with that prefix.
  [Supersession path](https://github.com/rohitg00/agentmemory/blob/e04ba88819c365c9acf9d6661ea802143e728bd6/src/functions/remember.ts#L82-L95)
- Core recall projects memories into observation-shaped results and omits some
  stored metadata. Search-critical title, content, concepts, and source
  provenance cannot rely only on `origin` or `project` fields.
- Hourly auto-forget compares records sharing concepts without a project guard.
  Mapping the universal `memory` tag to every record would create an
  unnecessarily broad comparison set.
- Bulk import bypasses live-observation credential and private-marker
  redaction. Requirements explicitly accept verbatim import of already-curated
  local notes.

## Requirement-to-Asset Map

| Requirement | Existing assets | Gap |
|---|---|---|
| 1. Source selection | Markdown/YAML helpers in `cavemem-import-vault.js` | **Missing:** contained regular-file walk for `memories/*.md` |
| 2. Content/provenance | AgentMemory memory schema; canonical note format in prompt sources | **Missing:** validated note-to-memory mapping and recall-visible provenance |
| 3. One-shot operation | Existing AgentMemory importer wrapper, auth, report, and tests | **Missing:** Obsidian-specific command and memory payload support |
| 4. Reruns | Deterministic hashes and AgentMemory `skip` strategy | **Constraint:** path identity does not reconcile edits or renames |
| 5. MCP retirement | `baseServers`, package overlay, host vault values | **Removal:** server, option, package, values, runtime-copy assertions |
| 6. Startup cutover | OpenCode wrapper and Pi status preflight code | **Removal:** Obsidian probe while retaining mcpproxy/AgentMemory checks |
| 7. Prompt cutover | Composed global context, agent catalogs, Pi and Shopify sources | **Broad change:** replace saves/recall and remove vault roles in source and generated fixtures |

## Implementation Options

### Option A: Extend the Cavemem importer

Add a source mode and AgentMemory memory-record support to
`agentmemory-import-cavemem.ts`.

- Pros: Reuses mature batching, auth, response, and reporting code directly.
- Cons: Couples unrelated SQLite and Markdown migrations in an existing
  1,200-line file; command semantics and reports become harder to understand.

### Option B: New importer with a small shared transport seam

Create an Obsidian-specific importer and extract only stable AgentMemory payload,
submission, and report primitives where reuse is clear.

- Pros: Separate source lifecycle and tests; avoids duplicating protocol limits.
- Cons: A shared extraction can widen the patch if existing importer regression
  coverage is incomplete.

### Option C: Independent thin importer

Create a standalone importer that copies the small required protocol patterns
without refactoring the existing Cavemem importer.

- Pros: Fastest bounded implementation and lowest regression surface.
- Cons: Duplicates auth, payload limits, and response checks that must stay
  aligned with the pinned target.

The runtime and prompt retirement work is identical for all three options.

## Complexity and Risk

- **Effort: M (3–7 days).** Import logic follows established patterns, but the
  prompt and generated-fixture inventory is broad.
- **Risk: Medium.** The target protocol is known; partial import behavior and
  stale generated prompt content are the primary failure modes.

## Design Carry-Forwards

- Commit the exact target memory mapping, including type, timestamps, concepts,
  files, source path, project, and legacy session provenance.
- Keep universal `memory` and project tags out of the broad concept set unless
  their auto-forget effect is intentionally accepted.
- Reject non-regular files and resolved paths outside the source directory.
- Validate complete memory records before serialization.
- Bound both record count and serialized bytes; report single-note oversize.
- Require HTTP success, `success: true`, and valid returned counts.
- Restart mcpproxy through the managed path and verify its live inventory after
  source configuration changes.
- Update both canonical instruction fragments and generated/plugin copies.
- Decide whether obsolete vault agent/script source files are deleted or merely
  unregistered; no active generation may expose them.
- Retire the Cavemem vault importer dependency on
  `home.mcp.obsidianVaultPath` without deleting Cavemem data.

## Remaining Unknowns

- Actual note count, malformed-note distribution, and largest note size are not
  known because the external vault was not read. Dry-run output resolves these
  operationally without changing spec scope.
- iii-engine uses Elastic License 2.0 and the current derivation's license-file
  handling predates this feature. The selected migration adds no new iii
  distribution surface; packaging remediation remains out of scope.
