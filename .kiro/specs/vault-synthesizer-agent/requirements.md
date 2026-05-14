# Requirements Document

## Introduction

Ship a new opencode subagent — `vault-synthesizer` — whose sole job is to read
a window of cavemem observations and draft new curated memory notes into the
Obsidian vault, applying the AGENTS.md "when to create a memory" criteria with
selectivity. The agent is the missing promotion bridge between cavemem (the
ambient capture surface stood up by `cavemem-integration`) and the curated
Obsidian memories surface that vault-curator already maintains. Without this
agent, cavemem accumulates observations indefinitely with no automated path
back into the curated vault.

The synthesizer is invoked manually (today) as `@vault-synthesizer <time-range>`
and as the first stage of the upcoming `memory-sync` orchestration command
(downstream `memory-sync-cli` spec). It is intentionally selective: it skips
low-signal clusters silently, never deduplicates against existing memories
(curator does that next), and never writes to the repo.

The agent is a single Markdown file at
`home-manager/common/agents/vault-synthesizer.md` plus a one-line wiring
addition in `home-manager/common/opencode.nix` so opencode actually loads it
on next rebuild. There is no Nix package, no script, no MCP tool, and no
schema to design — this spec is purely an agent definition and the minimum
wiring needed to deliver it.

## Boundary Context

- **In scope**: The `vault-synthesizer.md` agent definition file (frontmatter
  + body); the one-line addition to the existing `agents` attrset in
  `home-manager/common/opencode.nix` so the new agent is loaded; the agent
  body's inlined memory criteria (verbatim copy of the AGENTS.md
  `<!-- BEGIN: memory-criteria -->` / `<!-- END: memory-criteria -->` block);
  the agent's selectivity rubric with skip-vs-promote examples; the agent's
  workflow definition (gather → group → score → draft → report); the agent's
  permission block (deny `edit`/`write`/`webfetch`, bash allow-list mirroring
  vault-curator's); the agent's MCP tool allow-list (the `hub_obsidian__*`
  read/write surface plus `hub_cavemem__*` read tools); the agent's
  structured-return contract (counts + draft paths) so the downstream
  `memory-sync-cli` orchestrator can consume it; a manual smoke-test recipe
  documented in the agent body.
- **Out of scope**: Modifications to `home-manager/common/agents/vault-curator.md`
  (curator continues unchanged); modifications to `home-manager/common/agents.md`
  (the AGENTS.md restructure is owned by `cavemem-integration`); creation or
  modification of any cavemem MCP tool (`cavemem-integration` owns the
  tools and their server registration under the literal name `cavemem`);
  creation of the `memory-sync` orchestration command or any auto-scheduling
  (`memory-sync-cli` spec); creation of new vault directories, MOCs, or tag
  taxonomies (curator's job); writes to any path outside the Obsidian vault;
  network access from the agent at runtime; deduplication of drafts against
  existing memories (curator does dedup as the next stage of the pipeline).
- **Adjacent expectations**: This spec consumes the contracts locked by
  `cavemem-integration` Requirement 10: (a) the cavemem MCP server is
  registered in mcphub under the literal name `cavemem`, so its tools are
  reachable as `hub_cavemem__*`; (b) the AGENTS.md memory criteria block
  remains intact and wrapped in `<!-- BEGIN: memory-criteria -->` /
  `<!-- END: memory-criteria -->` anchor markers so the verbatim quote in
  this agent's body stays in sync with the source of truth; (c) cavemem
  observations contain non-empty `input`/`output` fields (the bug #14 patch
  is applied) so the synthesizer has actual content to score. The downstream
  `memory-sync-cli` spec consumes this agent's structured return shape and
  invocation surface (time-range argument plus default-window fallback).

## Requirements

### Requirement 1: Agent Definition File Exists and Loads

**Objective:** As a host operator, I want a `vault-synthesizer` subagent
loaded by opencode automatically on next rebuild, so that I can invoke it
as `@vault-synthesizer` from any opencode session without imperative setup.

#### Acceptance Criteria

1. The repository shall contain a single file at
   `home-manager/common/agents/vault-synthesizer.md` that defines the
   `vault-synthesizer` subagent.
2. The file shall begin with a YAML frontmatter block whose top-level keys
   include `description`, `mode`, `model`, `temperature`, and `permission`.
3. The frontmatter `mode` value shall be `subagent`.
4. The frontmatter `description` shall be a one-line natural-language summary
   that names cavemem, names the time-range argument, and names the
   `@vault-synthesizer` invocation alias so opencode's task router can pick
   it up for delegation phrases like "synthesize my recent sessions" or
   "draft memories from cavemem".
5. The `agents` attrset in `home-manager/common/opencode.nix` shall include
   a `vault-synthesizer` entry that loads
   `./agents/vault-synthesizer.md` through the existing `withCaveman` helper,
   following the same pattern as the four pre-existing agent entries
   (`nix-pkg`, `nvim-tailor`, `security-auditor`, `vault-curator`).
6. After a rebuild on a host with `home.cavemem.enable = true`,
   `@vault-synthesizer` shall be a recognized agent name within an opencode
   session; the agent's system prompt shall include the body of
   `vault-synthesizer.md`.
7. While `home.cavemem.enable` is false on a host, the agent shall still be
   loadable but the operator shall expect the agent to fail at runtime
   because cavemem MCP is unavailable; this spec does not gate loading on
   the cavemem option (gating happens at the cavemem MCP layer).

### Requirement 2: Model and Sampling Settings

**Objective:** As an agent author, I want the synthesizer to use a model
heavy enough for selective synthesis judgment but not so heavy that
routine runs are wasteful, so that promotion quality is high without
needlessly burning context budget.

#### Acceptance Criteria

1. The frontmatter `model` value shall be `anthropic/claude-sonnet-4-5`.
2. The frontmatter `temperature` value shall be `0.2`.
3. The agent definition shall not declare any other sampling option
   (no `top_p`, no `max_tokens`, no `thinking` block) so opencode's
   defaults apply.

### Requirement 3: Permission Block Enforces Read-Only-On-Repo Posture

**Objective:** As a host operator, I want the synthesizer locked to the
Obsidian vault and cavemem read surface so it can never modify repo source,
exfiltrate over the network, or shell out to anything beyond a tight
inspection allow-list.

#### Acceptance Criteria

1. The frontmatter `permission.edit` value shall be `deny`.
2. The frontmatter `permission.write` value shall be `deny`.
3. The frontmatter `permission.webfetch` value shall be `deny`.
4. The frontmatter `permission.bash` table shall set the wildcard `"*"` to
   `ask` and shall explicitly `allow` only the following commands: `ls *`,
   `find *`, `rg *`, `grep *`, `wc *`, `head *`, `tail *`. No other bash
   commands shall be allow-listed.
5. The agent body shall state explicitly that vault writes happen through
   `hub_obsidian__write-note` only, that repo source is out of scope, and
   that the OS-level `edit`/`write` denies are defense-in-depth on top of
   that prompt rule.

### Requirement 4: MCP Tool Consumption Surface

**Objective:** As an agent author, I want the synthesizer to use only the
specific Obsidian and cavemem MCP tools required for its job, so that it
cannot accidentally call out-of-scope tools (e.g., GitHub MCP, web fetch
MCP) and produce surprising side effects.

#### Acceptance Criteria

1. The agent body shall name `hub_obsidian__write-note` as the only tool
   used to draft memory notes into the Obsidian vault.
2. The agent body shall name `hub_obsidian__read-note` as the tool used to
   cross-check the produced note's format (read-back) and shall state that
   the agent does not use it for deduplication against existing memories.
3. The agent body shall name `hub_cavemem__list_sessions`,
   `hub_cavemem__timeline`, `hub_cavemem__get_observations`, and
   `hub_cavemem__search` as the cavemem MCP tools the agent may call,
   describing the role of each (`list_sessions` to enumerate sessions in a
   time range, `timeline` to enumerate observation IDs per session,
   `get_observations` to fetch full observation bodies for promotion
   candidates, `search` for ad hoc disambiguation queries during clustering).
4. The agent body shall state that no other MCP tools are used; in
   particular, the agent shall not invoke any `hub_github__*`,
   `hub_observe_*`, `hub_buildkite__*`, or web-fetch MCP tools.
5. The agent body shall reuse the Obsidian MCP quirk notes already
   documented in `vault-curator.md` (search-vault `includeContext: true`
   schema-validation flake; `list-notes` count-vs-array gap; absolute-vs-
   vault-relative path expectations on `read-note`) so the synthesizer
   handles the same gotchas without rediscovering them.

### Requirement 5: Inlined AGENTS.md Memory Criteria

**Objective:** As a curator-pipeline operator, I want the synthesizer's
selectivity rubric to be exactly the AGENTS.md memory criteria, so that
curator and synthesizer share one definition of "what counts as a memory"
and disagreement between them is impossible by construction.

#### Acceptance Criteria

1. The agent body shall include the AGENTS.md memory criteria block
   verbatim, copied from inside the `<!-- BEGIN: memory-criteria -->` /
   `<!-- END: memory-criteria -->` markers in `home-manager/common/agents.md`
   (the markers themselves are introduced by the `cavemem-integration`
   spec).
2. The verbatim quote shall include both the "create a memory when" list
   (decision made; non-obvious fact; reusable pattern; bug root cause;
   configuration / architecture explained in depth) and the "do NOT create"
   list (routine file edits; simple lookups; temporary information;
   already-captured information).
3. The agent body shall preserve the AGENTS.md anchor-marker comments
   (`<!-- BEGIN: memory-criteria -->` and `<!-- END: memory-criteria -->`)
   in the inlined copy so a future maintainer can grep for the markers in
   the agent file and confirm the block came from the canonical source.
4. The agent body shall instruct the agent to apply this rubric to every
   candidate observation cluster and to skip clusters that fall into any
   of the "do NOT create" buckets without producing a draft.

### Requirement 6: Selectivity Rubric With Concrete Skip / Promote Examples

**Objective:** As an agent author and as the operator reviewing this
agent's drafts, I want the agent's selectivity rubric to be illustrated
with concrete examples drawn from this codebase's actual memory shape, so
that selectivity decisions are reproducible and not implicit.

#### Acceptance Criteria

1. The agent body shall include a "Selectivity rubric" section that
   contains at least three concrete promote examples, each showing a
   plausible cavemem observation cluster and the resulting memory title /
   structure.
2. The "Selectivity rubric" section shall include at least three concrete
   skip examples covering, at minimum: a routine file-read cluster, a
   build/test output cluster, and a cluster that restates information
   already in an existing curated memory (where the agent skips because
   the signal is unclear, not because it deduplicated).
3. The rubric examples shall reference real-shaped categories from this
   repo's memory tag space (e.g., `nix-config`, `graphite`, `cavemem`,
   `yugabytedb`) so the synthesizer recognizes those clusters when it
   sees them.
4. The rubric shall state explicitly that the synthesizer errs on the
   side of NOT promoting when signal is unclear, because false positives
   pollute the vault but false negatives can be re-synthesized from the
   same cavemem range later.

### Requirement 7: Workflow Definition

**Objective:** As an agent author, I want the synthesizer's runtime
workflow to be a fixed, documented sequence of stages so that the agent's
behavior is predictable across runs and the downstream orchestrator can
reason about its outputs.

#### Acceptance Criteria

1. The agent body shall include a "Workflow" section that defines exactly
   five stages in order: gather, group, score, draft, report.
2. The "gather" stage shall be defined as: resolve the time range; call
   `hub_cavemem__list_sessions` for sessions in the window; for each
   session, call `hub_cavemem__timeline` to enumerate observation IDs.
3. The "group" stage shall be defined as: cluster observations by session
   and topic, using cavemem's observation `kind` field plus content
   keywords as the clustering signal; clustering may also use
   `hub_cavemem__search` for disambiguation when keyword overlap is
   ambiguous.
4. The "score" stage shall be defined as: apply the selectivity rubric
   from Requirement 6 to each cluster; high-signal clusters become
   promotion candidates, low-signal clusters are skipped silently.
5. The "draft" stage shall be defined as: for each promotion candidate,
   call `hub_cavemem__get_observations` for the cluster's observation
   IDs, compose a memory note that conforms to Requirement 9, and write
   it via `hub_obsidian__write-note` to a path under `memories/`.
6. The "report" stage shall be defined as: emit the structured summary
   defined in Requirement 8.
7. The workflow shall state explicitly that the agent does not call
   `hub_obsidian__search-vault` or `hub_obsidian__search-by-tags` to
   check whether a similar memory already exists; deduplication is
   curator's responsibility in the next pipeline stage.

### Requirement 8: Structured Return Contract for Downstream Consumers

**Objective:** As the future `memory-sync-cli` orchestrator, I want the
synthesizer to emit a structured summary at the end of every run so that
I can pipe its output to vault-curator and present a meaningful summary
to the operator without parsing free-form prose.

#### Acceptance Criteria

1. The agent body shall define a "Report" section that the agent uses to
   produce its final structured summary at the end of every run.
2. The structured summary shall include the count of cavemem observations
   the agent scanned in the time window.
3. The structured summary shall include the count of clusters the agent
   identified during the group stage.
4. The structured summary shall include the count of memory drafts the
   agent wrote during the draft stage.
5. The structured summary shall include the vault-relative paths of every
   memory draft the agent wrote during the draft stage (one path per
   line or in a list, formatted so that the downstream orchestrator can
   pass each path to vault-curator).
6. The structured summary shall include the resolved time-range bounds
   (start and end timestamps) the agent operated against, so the
   downstream orchestrator can include them in its operator-facing
   summary or marker file.
7. While the agent skips clusters silently per Requirement 6, the
   structured summary shall report the count of skipped clusters so the
   operator can see selectivity in action.

### Requirement 9: Drafted Memory Notes Pass Curator Audit

**Objective:** As vault-curator, I want every memory note the
synthesizer drafts to conform to the existing memory format so that I do
not have to repair frontmatter or restructure bodies during the
deduplication pass.

#### Acceptance Criteria

1. The agent body shall specify that every drafted memory note is
   written to `memories/<YYYY-MM-DD>-<slug>.md` where `<slug>` is 3-5
   words in kebab-case (matching the existing memory path convention).
2. The agent body shall specify that every drafted memory note's YAML
   frontmatter contains the keys `tags`, `date`, `project`, and
   `sessions`, in that order, matching the existing memory frontmatter
   convention.
3. The agent body shall specify that the `tags` list always includes
   `memory`, the project tag (derived from the cavemem session's
   project context), and 1-5 additional topical tags drawn from the
   observation cluster's content; total tag count shall be between 3
   and 7 (matching AGENTS.md tag guidelines).
4. The agent body shall specify that the `sessions` list contains the
   cavemem session ID(s) that the observation cluster was synthesized
   from (e.g., `cavemem-session-abc123`), so vault-curator and humans
   can trace any drafted memory back to the source cavemem observations
   during the curation pass.
5. The agent body shall specify that the memory body contains, in
   order, an H1 line stating the fact / decision / pattern (concise,
   one sentence), a `## Context` section describing where and why the
   knowledge was discovered, a `## Details` section containing the
   actual knowledge, and a `## Related files` section listing any
   relevant file paths surfaced from the cavemem observations.
6. The agent body shall specify that no drafted memory note's frontmatter
   `date` value precedes the earliest cavemem observation timestamp in
   the cluster (so dates remain coherent with the source data the
   memory came from).
7. The agent body shall include a worked example of a complete drafted
   memory note (frontmatter + body, ~30-50 lines) so the agent has a
   concrete reference template at runtime.

### Requirement 10: Time-Range Invocation Contract

**Objective:** As an operator (and as the upstream `memory-sync-cli`
orchestrator), I want a clear, robust invocation contract for time
ranges so that the agent does the right thing across relative ("last 7
days"), absolute ("2026-05-01 to 2026-05-13"), and missing-argument
invocations.

#### Acceptance Criteria

1. The agent body shall document an "Invocation" section that names the
   four accepted invocation shapes, each illustrated with a concrete
   example: (a) relative — `"last N days"` or `"last N hours"` (e.g.,
   `"last 7 days"`, `"last 24 hours"`); (b) absolute date pair —
   `"YYYY-MM-DD to YYYY-MM-DD"` interpreted in the host's local
   timezone (e.g., `"2026-05-01 to 2026-05-13"`); (c) ISO-8601 duration
   — a single duration string anchored to "now" (e.g., `"P7D"`,
   `"PT24H"`); (d) ISO-8601 timestamp pair — `"<start> to <end>"` where
   each side is an RFC 3339 UTC instant `YYYY-MM-DDTHH:MM:SSZ` (e.g.,
   `"2026-05-01T00:00:00Z to 2026-05-13T22:30:00Z"`). The fourth shape
   is the exact format the downstream `memory-sync-cli` orchestrator
   emits when it composes the synthesizer prompt from its marker file.
2. The agent body shall specify that when no time range is provided,
   the agent defaults to the last 24 hours from invocation time.
3. The agent body shall specify that the resolved time-range bounds are
   reported in the structured summary per Requirement 8.6 so the
   orchestrator can see the actual window the agent used.
4. If a user-provided time range cannot be parsed against any of the
   four accepted shapes, the agent shall refuse the run, print an
   actionable error message that names all four accepted shapes with
   one example each, and produce no drafts.
5. The agent body shall specify timezone interpretation per shape:
   relative shapes are anchored to "now" in the host's local timezone;
   absolute date pairs are interpreted as local time (no timezone in
   the input); ISO-8601 durations are anchored to "now" in the host's
   local timezone; ISO-8601 timestamp pairs are interpreted as UTC
   instants (the trailing `Z` is mandatory; the agent shall reject
   timestamp pairs without it as unparseable per AC4).
6. While the time window is empty (cavemem reports zero sessions), the
   agent shall still emit a structured summary per Requirement 8 with
   zero counts for scanned / clustered / drafted / skipped, and shall
   not produce any drafts.
7. The agent shall accept the ISO-8601 timestamp pair shape
   `"<start> to <end>"` where each side is `YYYY-MM-DDTHH:MM:SSZ`
   (RFC 3339 UTC, trailing `Z` mandatory). This is the exact shape
   `memory-sync-cli` emits when it composes the synthesizer prompt
   from its marker file: `start` is the marker timestamp from the
   prior successful run, `end` is the current invocation time, and
   both are stored and rendered by `memory-sync-cli` as ISO 8601 UTC
   per its own Decision 4 / Requirement 6.AC1. Without this shape, the
   first end-to-end `memory-sync` run would fail because the
   synthesizer would refuse the orchestrator's prompt under AC4.

### Requirement 11: Manual Smoke-Test Recipe

**Objective:** As the implementer (and as a future operator validating
this agent after a cavemem version bump), I want a smoke-test recipe
documented inside the agent body so I can run it manually against
today's cavemem session and confirm end-to-end behavior without
hunting for instructions.

#### Acceptance Criteria

1. The agent body shall include a "Success criteria" section describing
   the manual smoke test the implementer runs immediately after the
   agent ships.
2. The smoke-test recipe shall instruct the operator to run
   `@vault-synthesizer 24 hours` against today's cavemem session.
3. The smoke-test recipe shall list the three pass conditions:
   (a) at least one memory draft is produced;
   (b) the draft conforms to the format defined in Requirement 9 (such
   that vault-curator's audit accepts it unchanged);
   (c) no observation from a cavemem session whose `cwd` differs from
   the synthesis time-range's project context leaks into a draft
   (the cross-project privacy check; depends on the bug #39 patch from
   `cavemem-integration`).
4. The smoke-test recipe shall name the recovery path when any pass
   condition fails: re-run `cavemem-smoke-test` (the regression
   detector shipped by `cavemem-integration`) before re-attempting the
   synthesizer run.
