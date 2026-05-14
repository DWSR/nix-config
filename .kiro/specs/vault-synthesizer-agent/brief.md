# Brief: vault-synthesizer-agent

## Problem

After cavemem-integration ships, raw observations land in `~/.cavemem/data.db`
ambiently — every prompt, tool call, and tool response from every opencode
session. That's good for short-term recall but unusable as long-term knowledge:
the observations are voluminous, low-signal individually, and not tagged or
cross-referenced. The vault-curator subagent operates on already-curated
memory notes; it doesn't know how to read cavemem and doesn't know how to
apply the AGENTS.md "when to create a memory" criteria. We need a new agent
whose job is exactly that promotion step: read a window of cavemem
observations, find the high-signal ones, and draft new memory notes that
fit the existing memory format and tag conventions.

Without this agent, cavemem accumulates observations indefinitely with no
path back into the curated Obsidian surface. The user would have to manually
open cavemem's MCP search, hand-pick observations, and write memory notes
themselves — which is exactly the burden cavemem-integration was supposed
to remove.

## Current State

- **Existing subagents**: `home-manager/common/agents/` contains
  `nix-pkg.md`, `nvim-tailor.md`, `security-auditor.md`, `vault-curator.md`.
  All follow the same frontmatter+body structure: `description`, `mode:
  subagent`, `model`, `temperature`, `permission` block (edit/write/webfetch/bash
  allow-list), then a Markdown body defining the agent's mission, invariants,
  workflow, and tool usage notes.
- **vault-curator** is the closest analogue: it operates on the Obsidian
  vault via `hub_obsidian__*` tools, denies repo writes, and uses a strict
  bash allow-list. It deduplicates and consolidates rather than synthesizes.
- **Memory criteria** (from AGENTS.md): "Create a memory when ANY of these
  occur: A decision was made, A non-obvious fact was discovered, A reusable
  pattern was established, A bug root cause was identified, A configuration
  or architecture was explained in depth." The synthesizer must apply this
  rubric to every cavemem observation cluster.
- **Cavemem MCP tools** (after cavemem-integration): `cavemem search`,
  `cavemem timeline`, `cavemem list_sessions`, `cavemem get_observations(ids[])`.
  The agent will use `timeline` to enumerate observations in a time range and
  `get_observations` to retrieve full bodies for promotion candidates.
- **Existing memory format** (also from AGENTS.md): YAML frontmatter
  (`tags`, `date`, `project`, `sessions`), `# Concise statement`, `## Context`,
  `## Details`, `## Related files`. The synthesizer must produce notes that
  pass vault-curator's audit unchanged.

## Desired Outcome

When this spec is done:

1. `home-manager/common/agents/vault-synthesizer.md` exists, follows the
   established subagent pattern, and is loaded by opencode automatically
   on next rebuild.
2. The agent can be invoked manually as `@vault-synthesizer` with a time
   range argument (e.g., "synthesize the last 7 days") and it:
   - Queries cavemem for sessions and observations in that window
   - Groups observations by session/topic/project
   - Applies the AGENTS.md memory criteria with selectivity (skips routine
     file reads, formatting, build output, etc.)
   - For each promotable cluster, drafts a memory note that conforms to the
     established format
   - Writes drafts to `memories/<YYYY-MM-DD>-<slug>.md` via
     `hub_obsidian__write-note`
   - Does NOT dedup against existing memories (vault-curator handles that
     in the next stage of the orchestration)
   - Returns a structured summary: how many observations scanned, how many
     clusters identified, how many memory drafts written, paths of drafts
3. The agent's permission block restricts:
   - `edit: deny` (no repo writes)
   - `write: deny` (no filesystem writes outside Obsidian MCP)
   - `webfetch: deny` (everything it needs is local)
   - `bash`: tight allow-list (`ls`, `find`, `rg`, `grep`, `wc`, `head`,
     `tail`); same as vault-curator
   - Available MCP tools: `hub_obsidian__write-note`,
     `hub_obsidian__read-note` (for cross-checking format), `hub_cavemem__*`
4. The agent's body documents:
   - Mission (synthesize cavemem → curated memories)
   - Operating rules / invariants
   - Inlined memory criteria (verbatim from AGENTS.md so the agent doesn't
     have to load the full AGENTS.md)
   - Workflow (gather → group → score → draft → report)
   - Selectivity rubric with examples of what to keep and what to skip
   - Tool usage notes (cavemem-MCP quirks, Obsidian-MCP quirks already
     documented in vault-curator.md)
   - Success criteria

## Approach

Mirror the vault-curator subagent pattern exactly. Specifically:

1. **File location**: `home-manager/common/agents/vault-synthesizer.md`.
   The agents directory is glob-loaded by opencode via existing HM wiring,
   so no `default.nix` change is needed.
2. **Frontmatter**:
   - `description`: concise one-liner that mentions cavemem, time range,
     and "complement vault-curator" so opencode's task router picks it up
   - `mode: subagent`
   - `model: anthropic/claude-sonnet-4-5` (heavier than vault-curator's
     haiku because synthesis requires judgment about content; selectivity
     is the value add)
   - `temperature: 0.2` (slightly more permissive than curator's 0.1 to
     allow more creative slug naming and cross-referencing, but still
     conservative)
   - `permission` block: same shape as vault-curator
3. **Body sections**:
   - Mission (1 paragraph)
   - Operating rules / invariants (numbered list, mirrored from
     vault-curator's structure, with synthesizer-specific items: "never
     dedup; that's the curator's job", "every memory note must include
     the cavemem session_id(s) it was synthesized from in the `sessions:`
     frontmatter")
   - Inlined AGENTS.md memory criteria (verbatim, so the agent can quote
     them as the selectivity rubric)
   - Workflow:
     a. Gather: call `hub_cavemem__list_sessions` for the time range; for
        each session, call `hub_cavemem__timeline` for the observation IDs
     b. Group: cluster observations by session and topic (using cavemem's
        `kind` field plus content keywords)
     c. Score: apply the selectivity rubric — high-signal clusters get a
        promotion candidate, low-signal ones are skipped silently
     d. Draft: for each high-signal cluster, fetch full observation bodies
        via `hub_cavemem__get_observations(ids[])`, compose the memory
        note, write via `hub_obsidian__write-note`
     e. Report: structured summary of work done
   - Selectivity rubric with concrete examples (what looks like a decision,
     what looks like a discovery, what looks like a routine file read)
   - Tool usage notes (cavemem MCP quirks once known; Obsidian MCP quirks
     copied from vault-curator's existing list)
   - Success criteria
4. **Memory note format**: produced notes follow the existing format
   exactly. The `sessions:` frontmatter list contains cavemem session IDs
   (e.g., `cavemem-session-abc123`) so vault-curator can trace back to the
   source observations during dedup or audit.
5. **Manual smoke test plan**: After the agent ships, the implementer runs
   `@vault-synthesizer 24 hours` against today's cavemem session and
   confirms (a) at least one memory draft is produced, (b) the draft format
   passes vault-curator's audit, (c) no observations from cross-projects
   leak into the draft (privacy check; depends on cavemem-integration's
   bug #39 patch).

## Scope

- **In**:
  - The vault-synthesizer.md agent definition file
  - Selectivity rubric documentation (inlined memory criteria + concrete
    examples of skip vs promote)
  - Workflow definition (gather, group, score, draft, report)
  - Permission block (edit/write/webfetch denied; bash allow-list; MCP
    tools allow-list)
  - Cavemem MCP tool usage notes (filled in based on what cavemem-integration
    actually exposes)
  - Obsidian MCP quirks copied from vault-curator
  - Manual smoke-test recipe in the agent body's "Success criteria" section
- **Out**:
  - Modifications to vault-curator (this spec does not change the curator;
    the curator continues to dedup/MOC as before)
  - The orchestration command that invokes both agents (memory-sync-cli
    spec)
  - Auto-scheduled syntheses (memory-sync-cli spec)
  - Building cavemem MCP tools or exposing new ones (cavemem-integration
    spec)
  - Cross-host synthesis (cavemem is local; memories sync via Obsidian)
  - Promoting cavemem observations to anything other than memory notes
    (no MOC creation here, no transcription archival, no summary generation)

## Boundary Candidates

- **Selectivity scoring vs format compliance**: scoring decides what to
  promote; format compliance produces the actual note. Both are inside the
  agent's body but conceptually separable. Could be reviewed as two passes
  of the agent .md file but ship as one.
- **Cavemem-side queries vs Obsidian-side writes**: the agent is purely a
  read-from-cavemem, write-to-Obsidian transformer. Clean seam in the
  workflow definition.
- **Inlined memory criteria vs reference to AGENTS.md**: We inline because
  vault-curator does the same (lines 49-126 of vault-curator.md inline
  AGENTS.md verbatim). Keeps the agent self-contained.

## Out of Boundary

- Modifying vault-curator's behavior (curator continues to handle dedup,
  consolidation, MOC creation, tag hygiene)
- Modifying AGENTS.md memory criteria (this spec consumes them; the rules
  themselves were modified in cavemem-integration)
- Building MOCs (curator's job)
- Tagging policy decisions (use the existing tag guidelines)
- Cross-vault synthesis (one vault per host; this is unchanged)

## Upstream / Downstream

- **Upstream**:
  - `cavemem-integration` spec — provides the cavemem MCP tools and
    populated database that this agent reads
  - `home-manager/common/agents/vault-curator.md` — pattern to mirror
  - `home-manager/common/agents.md` — source of the memory criteria the
    agent will inline
- **Downstream**:
  - `memory-sync-cli` spec — invokes this agent with a time range and
    then chains vault-curator behind it

## Existing Spec Touchpoints

- **Extends**: None (new agent definition file; doesn't modify any existing
  spec's surface area).
- **Adjacent**:
  - `cavemem-integration`: read-side consumer of its MCP tools
  - vault-curator (existing, not in a spec): downstream consumer of this
    agent's output during the curation pass

## Constraints

- **No repo writes from the agent**: The synthesizer's only write surface
  is the Obsidian vault via MCP tools. `edit` and `write` permissions are
  denied at the OS level (defense-in-depth even though the prompt also
  forbids it).
- **No webfetch**: Everything is local. If the agent needs cross-references
  to GitHub issues etc., the user adds them manually after the draft is
  written.
- **Selectivity over coverage**: The agent must err on the side of NOT
  promoting an observation cluster if the signal is unclear. False positives
  pollute the vault; false negatives can be re-synthesized from the same
  cavemem range later.
- **Compatible with vault-curator**: Notes produced by the synthesizer
  must pass vault-curator's audit unchanged. That means valid frontmatter,
  correct tag conventions, no duplicate-titles-with-existing-memories
  (best-effort: the agent doesn't dedup, but it shouldn't write
  obviously-duplicate titles either).
- **Cavemem session ID provenance**: Every draft memory's `sessions:`
  frontmatter list includes the cavemem session ID(s) the observation(s)
  came from, so curator and humans can trace back to source.
- **Time-range robustness**: The agent must accept relative time ranges
  ("last 7 days", "last 24 hours") and absolute ones ("2026-05-01 to
  2026-05-13") and resolve them correctly. Default to last 24 hours if
  no range provided.
