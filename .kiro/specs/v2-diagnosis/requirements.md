# Requirements Document

## Introduction

v2-diagnosis is a successor to the `opencode-cost-diagnosis` v1 CLI
that closes v1's two structural reporting gaps: every input-token
bucket gains a non-null dollar attribution, and the previously-opaque
`cachedRead` bucket is decomposed into named sub-buckets matching the
cost-driver categories the deferred specs in `.kiro/steering/roadmap.md`
need to evaluate their triggers. v2 ships as a drop-in replacement
for v1 -- same CLI entry-point name, same selection and output flags,
same default output location, same install pattern -- so the operator
runs the same command and consumes reports in the same place; the
information density of each report is what changes. v2 preserves
every v1 invariant verbatim (read-only DB access, byte-identical JSON
determinism, default-exclude privacy posture, schema-drift loud
failure, identical command surface on both nix-darwin hosts,
declarative install on both hosts, no SaaS dependency) and does not
re-specify them; this document covers only the v2-additive
capabilities and the user-observable contract changes around them.
Like v1, v2 is itself a diagnostic, not an optimizer; it does not
implement any cost reduction.

## Boundary Context

- **In scope**:
  - A drop-in replacement of the v1 diagnostic on both nix-darwin
    hosts, with no change to the CLI entry-point name, the selection
    or output flags, the default output location, or the install
    pattern.
  - Per-bucket dollar attribution for every per-session token field
    the v1 report already populates, at per-session, per-project,
    and global aggregation levels.
  - Decomposition of `cachedRead` into named sub-buckets covering
    base system prompt, AGENTS.md content, MCP tool schemas,
    accumulated conversation history, and accumulated tool-output
    content carried inside the cached prefix.
  - Decomposition of `subagentDispatch` into per-agent-type
    sub-buckets, suitable as the before/after measurement primitive
    for the concurrent `subagent-context-budget` spec.
  - Decomposition of `toolOutputs` into per-tool sub-buckets keyed
    by the tool name opencode records per tool call.
  - A pricing data set that ships bundled with the diagnostic,
    keyed by the model identity opencode records per assistant
    turn, with operator-visible pin metadata in every report.
  - Drift handling for unknown pricing keys and reconciliation
    findings for per-bucket sum mismatches against opencode's
    authoritative per-turn cost; both surface as findings without
    blocking report emission.
  - Forward compatibility for v1 report consumers: additive JSON
    schema, preserved byte-identical determinism, preserved
    sum-correctness invariants, preserved findings, and the
    null-to-value transition for the per-bucket cost fields v1
    left null.

- **Out of scope**:
  - Every item from v1's `Out of scope` list carries forward into
    v2 unchanged: cost-reduction interventions of any kind
    (prompt-caching enablement, MCP allowlist, AGENTS.md
    modularization, session compaction, tool-output compression,
    rtk install, model routing), Helicone or Langfuse integration,
    real-time dashboards or web UIs, cross-host data merge,
    Anthropic Admin Cost Report API as the primary data source,
    cost forecasting, anomaly detection, and report-to-report diff
    convenience. The optional live-logger plugin that was deferred
    in v1 remains deferred in v2.
  - Multi-currency support, discounts, prepaid-credit accounting,
    contract-rate accounting; the report uses list-price rates
    only.
  - Auto-fetching pricing from any remote source at report-run
    time; pricing updates are an operator-initiated refresh of the
    bundled data set.
  - Coexistence of v1 and v2 on PATH; only one diagnostic exists
    per host at a time.
  - Modifications to opencode itself or to the schema of the
    session database it owns.
  - Evaluating or recommending which deferred specs in
    `roadmap.md` should ship next; v2 produces the evidence,
    follow-on specs interpret it.

- **Adjacent expectations**:
  - **opencode**: v2 inherits v1's read-only-consumer relationship
    with opencode's session database and v1's dependency on the
    per-turn token counters and prompt-cache fields opencode
    already records. v2 additionally depends on opencode persisting
    model identity (the per-turn provider and model fields opencode
    already records). If those fields are absent or unrecognized
    for a session, that session's per-bucket dollar fields fall
    back to v1's null behavior and the report surfaces a finding
    rather than failing.
  - **opencode-cost-diagnosis v1**: v2 replaces v1 at install time;
    they do not coexist. v1's deferred live-logger plugin (v1's
    Requirement 7) remains deferred in v2 and is not in scope here.
  - **Anthropic published pricing**: the source of truth for the
    bundled pricing data. When Anthropic publishes new rates, the
    operator manually refreshes the bundled data set; v2 does not
    auto-update. The pin metadata is visible in every report so
    stale prices cannot silently mislead.
  - **`subagent-context-budget` spec** (concurrent in the
    roadmap): consumes v2's per-agent-type sub-buckets as its
    before/after measurement primitive. v2 does not depend on
    `subagent-context-budget` shipping; if v2 ships first, the
    other spec's audit step is materially cheaper.
  - **Deferred specs in `roadmap.md`** (`agents-md-modularization`,
    `mcp-server-allowlist`, `tool-output-compressor`,
    `rtk-install`): each consumes v2's new sub-buckets to evaluate
    its trigger condition. v2 is the evidence-producer for those
    triggers but does not evaluate them.

## Requirements

### Requirement 1: Drop-in replacement of v1

**Objective:** As the operator of this nix-config (sole user across
two nix-darwin hosts), I want v2 to install and invoke exactly the
way v1 does, so I can adopt v2 without changing any habit or any
downstream consumer that already reads v1's output paths.

#### Acceptance Criteria

1. The diagnostic shall expose the same CLI entry-point name on
   PATH that v1 exposes.
2. The diagnostic shall accept the same selection and output flags
   v1 accepts and shall interpret them the same way, such that
   every v1 invocation form continues to produce a valid report.
3. When the operator runs the host's standard rebuild command with
   v2 enabled, the diagnostic shall replace v1 on PATH such that
   only one diagnostic binary exists per host.
4. The diagnostic shall write report files to the same default
   output location v1 uses and shall preserve v1's per-format
   pruning behavior, so report consumers do not need a new path
   convention.
5. The diagnostic shall preserve every v1 invariant that defines
   user-observable behavior, including: read-only access to the
   opencode session database, concurrent-safety with active
   opencode sessions, byte-identical JSON determinism for identical
   inputs, the default-exclude privacy posture and the
   content-disclosure opt-in semantics, the same per-user-readable
   file-permission posture v1 applies to report files,
   schema-drift loud-failure with a named supported version range,
   identical command surface on both nix-darwin hosts, and
   declarative install on both hosts.

### Requirement 2: Per-bucket dollar attribution

**Objective:** As the operator, I want every input-token bucket the
report already counts to also carry a dollar value, so I can rank
cost drivers by spend rather than by token volume (the two rankings
disagree materially for this model family).

#### Acceptance Criteria

1. The diagnostic shall report a non-null dollar value for every
   per-session token field the v1 report already populates,
   covering all of: cached-read input, cached-write input, the
   three uncached input sub-buckets v1 reports separately
   (system-prompt uncached, conversation history, tool outputs),
   output, reasoning, and subagent dispatch.
2. The diagnostic shall report the same per-bucket dollar values
   at the per-project and global aggregation levels using the same
   aggregation pattern v1 uses for token counts.
3. The diagnostic shall reconcile the sum of per-bucket dollar
   values against opencode's authoritative per-turn cost for each
   session, with a documented tolerance to absorb published
   rounding behavior.
4. If the per-bucket sum diverges from the authoritative cost
   beyond the documented tolerance for any session, the diagnostic
   shall surface a reconciliation finding naming the affected
   session and the magnitude of the divergence, and shall continue
   to emit the report.
5. Where the diagnostic decomposes a top-level bucket into named
   sub-buckets (per Requirements 4, 5, and 6), the diagnostic
   shall report dollar values for each sub-bucket using the same
   per-bucket rate as the parent bucket, such that the sub-bucket
   dollar totals sum exactly to the parent bucket's dollar total
   within the documented tolerance.

### Requirement 3: Bundled pricing data

**Objective:** As the operator, I want pricing to ship bundled with
the diagnostic from an operator-visible pinned source, so I am
never surprised by a remote pricing change and so a stale pin
cannot silently distort a report.

#### Acceptance Criteria

1. The diagnostic shall obtain pricing data only from a source
   bundled with the diagnostic at install time, and shall not
   fetch pricing from any remote source at report-run time.
2. The diagnostic shall key pricing lookups by the model identity
   opencode already records per assistant turn.
3. The diagnostic shall expose the pricing pin date and the source
   the pricing was pinned from, in both the Markdown and the JSON
   output of every report it emits.
4. If the diagnostic encounters an assistant turn whose model
   identity does not match any entry in the bundled pricing data,
   the diagnostic shall surface a pricing-drift finding naming
   the unmatched model identity, shall fall back to v1's
   null-valued per-bucket dollar behavior for the affected
   session, and shall continue to populate per-bucket dollar
   fields for sessions whose model identities are matched.
5. When the operator refreshes the bundled pricing data and reruns
   the diagnostic, the diagnostic shall reflect the new rates and
   the new pin metadata in the next report without any other
   reconfiguration step.

### Requirement 4: Cached-read decomposition

**Objective:** As the operator, I want the cached-read bucket
broken into named sub-buckets that match the cost-driver categories
the deferred specs need to evaluate, so I can verify their triggers
with evidence rather than guesswork.

#### Acceptance Criteria

1. The diagnostic shall decompose each session's cached-read
   bucket into named sub-buckets covering, at minimum: base system
   prompt, AGENTS.md content, MCP tool schemas, accumulated
   conversation history, and accumulated tool-output content
   carried inside the cached prefix.
2. The diagnostic shall enforce that the sum of cached-read
   sub-bucket token counts equals the cached-read bucket total
   exactly, with the last sub-bucket absorbing any rounding
   discrepancy (mirroring v1's sum-correctness pattern for the
   uncached split).
3. The diagnostic shall report cached-read sub-buckets at the
   per-session, per-project, and global aggregation levels, using
   the same aggregation pattern v1 uses for top-level buckets.
4. The diagnostic shall extend its accuracy disclaimer to name the
   cached-read sub-buckets whose values are tokenizer-derived,
   shall state that those sub-buckets are relative-only estimates
   suitable for ranking content populations within the cached-read
   bucket, and shall state that they sum exactly to the
   authoritative cached-read total.
5. If the diagnostic cannot classify a portion of cached-read
   content into any defined sub-bucket, the diagnostic shall route
   that portion into a clearly-named residual sub-bucket and shall
   surface a classification-residual finding naming the residual
   sub-bucket and the magnitude.

### Requirement 5: Subagent-dispatch per-agent-type decomposition

**Objective:** As the operator, I want subagent-dispatch tokens
broken down by agent type, so I can see which agent types dominate
cost and so the concurrent `subagent-context-budget` spec has a
direct before/after measurement primitive.

#### Acceptance Criteria

1. The diagnostic shall decompose each session's subagent-dispatch
   bucket into per-agent-type sub-buckets keyed by the agent type
   name opencode records per child session.
2. The diagnostic shall enforce that the sum of per-agent-type
   sub-bucket token counts equals the subagent-dispatch bucket
   total exactly, with the last sub-bucket absorbing any rounding
   discrepancy.
3. The diagnostic shall report per-agent-type sub-buckets at the
   per-session, per-project, and global aggregation levels.
4. Where the diagnostic folds subagent tokens into one or more
   residual sub-buckets (either because the agent type cannot be
   determined from the recorded data or because a known agent
   type fell below a configured volume threshold), the diagnostic
   shall name each residual distinctly, shall surface in the
   report which condition placed tokens there, and shall surface
   the volume threshold used.

### Requirement 6: Tool-output per-tool decomposition

**Objective:** As the operator, I want tool-output tokens broken
down by which tool produced them, so I can verify per-tool triggers
in `roadmap.md` (`rtk-install` for the Bash tool specifically;
`tool-output-compressor` for the native read tools) with evidence.

#### Acceptance Criteria

1. The diagnostic shall decompose each session's tool-output
   bucket into per-tool sub-buckets keyed by the tool name
   opencode records per tool call.
2. The diagnostic shall apply the per-tool decomposition to both
   the cached and the uncached portions of tool-output content
   where the underlying data distinguishes them, and shall surface
   in the report which portions are cached vs uncached.
3. The diagnostic shall enforce that the sum of per-tool
   sub-bucket token counts equals the tool-output bucket total
   exactly, with the last sub-bucket absorbing any rounding
   discrepancy.
4. The diagnostic shall report per-tool sub-buckets at the
   per-session, per-project, and global aggregation levels.
5. Where the diagnostic folds low-volume tools into an aggregated
   residual sub-bucket to keep report cardinality bounded, the
   diagnostic shall name the residual distinctly and shall surface
   the volume threshold in the report.

### Requirement 7: Forward compatibility for v1 report consumers

**Objective:** As the operator (and as any future automation that
parses v1's report output), I want v2's report output to be a
strict superset of v1's, so adopting v2 does not break any
human-reading habit or any downstream that already consumes v1's
JSON or Markdown.

#### Acceptance Criteria

1. The diagnostic shall populate every JSON field v1 emits with
   the same field name and the same shape; v2 may add new fields
   but shall not rename, remove, or change the shape of any
   existing field.
2. The diagnostic shall preserve v1's byte-identical JSON
   determinism for identical inputs across runs.
3. The diagnostic shall preserve v1's sum-correctness invariants
   for the uncached input sub-buckets verbatim, in addition to
   enforcing the new sum-correctness invariants this spec
   introduces.
4. The diagnostic shall preserve every v1 finding the report
   could previously emit; v2 may add new findings but shall not
   remove or rename existing findings.
5. When the diagnostic transitions a previously-null v1 field to
   a non-null v2 value (specifically, the per-bucket cost fields
   v1 left null and v2 populates), the diagnostic shall not
   change the field's name, type, or position in the JSON output,
   such that a v1 reader sees a value where it previously saw
   null without any other structural change.
