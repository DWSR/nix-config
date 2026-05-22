# Brief: subagent-context-budget

## Problem

Subagent dispatches are the second-largest input-token bucket across
all opencode work on this machine and a near-equal cost driver to the
main-thread system prompt itself. The most recent full-history cost
diagnostic (122 sessions, $7,478 total, generated 2026-05-18T00:45)
shows:

- `subagentDispatch` = 3,069,647,734 tokens = **28.2% of all input
  tokens** (10.88B total input)
- In the worst project (`bare-metal-disk-provisioning`, 3 sessions,
  $382.92), subagent tokens = 452,989,192, which is **1.58× the
  parent sessions' own `cachedRead` (286,642,277)**
- That single project accounts for ~5% of total spend and ~15% of
  total subagent volume

Each `task` dispatch starts a fresh Anthropic conversation: every
subagent re-ingests the full system prompt, AGENTS.md (global +
project), and every enabled MCP tool's schema. Anthropic prompt
caching is per-conversation, so the subagent gets no cache benefit
on its first turn (the most expensive turn for a typical short
subagent run). Subagents are also typically given much broader tool
access than they actually use — `general` and `explore` in particular
inherit the full tool surface even when their task is read-only.

Without intervention, every long session that fans out via the `task`
tool pays this tax linearly in the number of dispatches. The
`bare-metal-disk-provisioning` numbers show what happens when an
agentic workflow leans heavily on subagent fan-out: subagent cost
exceeds parent cost.

This is the only deferred spec in `roadmap.md` whose trigger
condition is unambiguously satisfied by the v1 diagnostic data. The
remaining deferred specs (`agents-md-modularization`,
`mcp-server-allowlist`, `tool-output-compressor`, `rtk-install`) all
require additional diagnostic decomposition before they can be
prioritized with evidence.

## Current State

- **Subagent inventory** (defined under `home-manager/common/agents/`
  and exposed via `opencode.agent` HM option): `explore`, `general`,
  `nix-pkg`, `nvim-tailor`, `security-auditor`, `vault-curator`,
  `vault-synthesizer`, `yb-sleuth`. Each agent's tool surface and
  system-prompt overlay is declared in its `*.md` definition file.
- **Global AGENTS.md**: `~/.config/opencode/AGENTS.md` — large
  (~30KB), includes the full memory protocol, the Graphite pitfall
  catalog, cc-sdd integration docs, and project memory rules.
  Inherited verbatim by every subagent type.
- **Project AGENTS.md** in this repo: appended on top of the global
  one for sessions running in this directory.
- **MCP servers wired in**: ~30 servers across `~/.config/mcphub`
  (cavemem, obsidian, github, gworkspace, observe, slack, vault,
  tool-gateway, infra-central, explainify, buildkite, chrome-devtools,
  storage, gcloud, fellow, nixos, gt, gworkspace, …). Every server's
  tool list is materialized into the system prompt for every subagent
  by default; there is no per-agent allowlist.
- **opencode subagent semantics**: a subagent is a child `session`
  row in `opencode-stable.db` with `parent_id` pointing at the
  dispatching session. The opencode-cost-diagnosis v1 Subagent
  Aggregator (see `opencode-cost-diagnosis/design.md`) walks this
  link and sums child-session tokens into the parent's
  `subagentDispatch` bucket.
- **No per-agent-type cost attribution** exists. The diagnostic
  reports `subagentDispatch` as a single number per parent session.
  We know *that* subagents are expensive; we do not yet know *which*
  subagent types dominate.

## Desired Outcome

After this spec lands and a representative workload is re-run, the
opencode-cost-diagnosis report shows a meaningful reduction in
`subagentDispatch` tokens per parent session. Target: **≥40%
reduction in `subagentDispatch` tokens per session** on a
diagnostic-replay workload comparable to `bare-metal-disk-provisioning`,
without functional regression (subagents still succeed at their
declared tasks).

Concretely:

- Each subagent type ships with an explicit `tools` allowlist
  (subset of the global tool surface) in its HM-managed definition.
- Subagent types that do not need the full global AGENTS.md (e.g.
  `explore`, `vault-curator`, `yb-sleuth` doing pure read-only
  investigation) skip the Graphite catalog and cc-sdd workflow
  sections via a per-agent AGENTS.md override or a conditional
  include mechanism.
- A "minimal subagent" baseline is defined: the smallest viable
  system-prompt + tool surface for a read-only exploration subagent,
  measured in tokens. This becomes the reference point for future
  subagent-type additions.
- The cost diagnostic is extended (or v2-diagnosis lands first) to
  break down `subagentDispatch` by agent type, so the
  before/after measurement is verifiable.

## Approach

Three workstreams, in order:

1. **Audit and instrument**. For each existing subagent type:
   measure its current first-turn input token count via a synthetic
   no-op dispatch (`task` invocation that returns immediately). Pair
   each agent with the smallest set of tools observably used in
   recent sessions (read from the diagnostic's part-row data:
   `part.type='tool'` rows under child sessions, grouped by tool
   name). This produces a per-agent "actually-used tools" baseline.
   Recommended dependency: this step is far easier if v2-diagnosis
   ships first (it provides per-tool breakdown). If v2 is not
   available, fall back to a one-shot scan written against the
   v1 Reader.

2. **Trim subagent definitions**. Update each agent's `*.md` in
   `home-manager/common/agents/` to declare an explicit `tools`
   allowlist. Introduce a per-agent AGENTS.md mechanism:
   - Option A: ship per-agent AGENTS.md files alongside the agent
     definition; opencode loads only the matching one for that
     subagent type.
   - Option B: split the global AGENTS.md into modular sections
     (memory, graphite, cc-sdd, …) and let each agent definition
     declare which sections it needs. This overlaps with the
     deferred `agents-md-modularization` spec — design phase decides
     whether to merge those scopes.
   The design phase picks A vs B based on what opencode actually
   supports (research task; opencode plugin hooks may allow runtime
   filtering).

3. **Validate**. Re-run a representative workload (or replay an
   archived session against an instrumented harness) and re-run the
   cost diagnostic. The before/after `subagentDispatch` delta is the
   success criterion. If the v2 diagnostic ships first, the
   per-agent-type breakdown is checked for the expected pattern
   (specific agents dropping in proportion to how aggressively they
   were trimmed).

## Scope

- **In**:
  - Per-agent-type tool allowlist enforcement in
    `home-manager/common/agents/*.md`
  - Per-agent or modular AGENTS.md so subagents inherit only the
    sections they need (mechanism decided in design phase)
  - Audit harness: a small script (likely shipped via HM module
    alongside `opencode-cost-diagnosis`) that dispatches a no-op
    task per agent type and emits the resulting first-turn token
    count, so this can be re-measured over time
  - Documentation of the "minimal subagent" baseline as a steering
    or memory note
  - Validation via re-running the existing opencode-cost-diagnosis
    on representative workloads

- **Out**:
  - Modifications to opencode itself (we work within what its agent
    + tool configuration already supports)
  - The `task` tool API surface
  - Subagent fan-out limits, parallelism caps, or cost circuit
    breakers (separate concerns; could become its own spec)
  - Cross-session caching of subagent prompts (Anthropic does not
    support this today)
  - Changing which subagent types exist or removing any (additive
    or modificatory only; no agent removals)
  - Routing decisions about when to dispatch a subagent vs do the
    work in the main thread (orthogonal optimization)

## Boundary Candidates

- **Audit and measurement harness**: the no-op dispatch tool + the
  per-tool-usage scan against the v1 / v2 diagnostic Reader. Could
  ship as a separate binary alongside `opencode-cost-report`.
- **Tool allowlists**: per-agent `tools:` declarations in
  `home-manager/common/agents/*.md`. Mechanical change; one PR per
  agent or one batched.
- **AGENTS.md per-agent overrides**: the mechanism (A vs B above) is
  the most opinionated boundary and may end up as its own internal
  seam in design.
- **Diagnostic per-agent breakdown**: if not delivered by
  v2-diagnosis, this spec absorbs a small extension to the existing
  Subagent Aggregator that groups child-session totals by agent
  type (readable from `session.data` JSON).

## Out of Boundary

- Building a new subagent type
- Cost-capping or rate-limiting subagent dispatch
- A general "context budget" enforcement mechanism for main-thread
  sessions (different problem; main thread has caching, subagents
  largely don't)
- Replacing or rewriting opencode's agent loader
- The Anthropic Admin Cost Report API (still out of scope per the
  v1 diagnostic's constraint set)

## Upstream / Downstream

- **Upstream**:
  - `opencode-cost-diagnosis` v1 — provides the `subagentDispatch`
    bucket totals and the parent-child session walk that proved the
    cost magnitude. Required to measure baseline.
  - `v2-diagnosis` (concurrent spec; same triggering report) —
    *strongly preferred upstream*: per-tool and per-agent-type
    breakdown makes the audit step (workstream 1) far cheaper. If
    v2 is not ready, this spec must build a one-off scan to fill
    the gap. Design phase decides ordering.
  - opencode's HM-managed agent configuration surface (the `tools`,
    `prompt`, and per-agent `instructions` options exposed by the
    nix-config `programs.opencode.agents.*` schema).

- **Downstream** (likely consumers; all deferred):
  - Future subagent additions inherit the "minimal subagent"
    baseline and `tools` allowlist convention defined here.
  - `agents-md-modularization` (deferred in roadmap) may share the
    AGENTS.md modular-include mechanism with this spec; design
    phase decides whether to land both together or sequentially.
  - Re-runs of `opencode-cost-diagnosis` after every future
    subagent change use the per-agent-type breakdown introduced
    here as the regression check.

## Existing Spec Touchpoints

- **Extends**: `opencode-cost-diagnosis` — adds per-agent-type
  attribution to the `subagentDispatch` bucket (either here or via
  v2-diagnosis).
- **Adjacent**:
  - `cavemem-integration` — pattern reference for AGENTS.md
    restructuring; cavemem-integration's Task 6 already restructured
    AGENTS.md for cavemem-awareness. The mechanism it used (or did
    not use) for conditional sections informs the A/B decision in
    Approach step 2.
  - `vault-synthesizer-agent` — recently-added subagent type;
    canonical example of a small-surface, single-purpose subagent.
    Should be one of the first agents whose tool surface is audited
    (likely already minimal; serves as a positive baseline).
  - `memory-sync-cli` — orchestrates two subagents
    (vault-synthesizer, vault-curator) outside of an interactive
    opencode session. This is a downstream consumer: subagent
    trimming makes `memory-sync` runs cheaper.

## Constraints

- **macOS-first** (nix-darwin on both Shopify and personal hosts)
- **Declarative install**: any new audit harness or per-agent
  AGENTS.md files ship via Nix overlay + HM module, like the rest
  of the agent definitions
- **No agent removals**: every existing subagent type continues to
  exist and remains functional. This is purely a trimming /
  scoping change, not a roster change.
- **Verifiable via existing diagnostic**: success is measured by
  re-running `opencode-cost-report`; no new measurement primitive
  is introduced unless v2-diagnosis ships first
- **Host parity**: both Shopify and personal hosts ship identical
  agent definitions. Per-agent trimming must not introduce
  host-specific divergence.
- **No regression in subagent capability**: trimmed subagents must
  still complete their declared task surface. Validation includes a
  smoke-test pass for each agent type (e.g., dispatch
  `explore` with a known query; dispatch `vault-curator` against a
  known vault state; etc.) before merge.
- **Reversible**: per-agent allowlists and AGENTS.md splits must be
  trivially reversible if a downstream regression surfaces. The HM
  module's option surface should accept an "allow everything"
  escape hatch per agent for emergency widening.
- **No external SaaS dependency** (no Helicone, Langfuse, etc.)
