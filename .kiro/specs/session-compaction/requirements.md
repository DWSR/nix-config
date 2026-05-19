# Requirements Document

## Introduction

The session-compaction feature reduces LLM API cost on this nix-config
host's opencode workflows by bounding the accumulated context that
long-running sessions feed back through Anthropic's prompt cache on
every turn. It does so by automatically invoking opencode's native
compaction machinery when configurable thresholds are exceeded,
augmenting the continuation prompt with prior-session context drawn
from cavemem, and providing a manual compaction surface for the human
or agent. The feature is installed declaratively on both nix-darwin
hosts, mirrors the install patterns of existing opencode integrations,
and depends on the existing cost diagnostic for before/after
measurement.

The feature is explicitly NOT a replacement or rewrite of opencode's
own compaction. It triggers, augments, and exposes opencode's existing
capabilities. Cavemem stays a read-only augmentation source; no
upstream cavemem changes are taken on by this spec. Per-tool output
compression, subagent prompt slimming, AGENTS.md modularization, and
MCP allowlisting are separate (deferred or in-flight) specs.

## Boundary Context

- **In scope**:
  - An opencode plugin that watches per-turn token usage and
    automatically invokes opencode's native compaction when
    configurable thresholds trip.
  - A pre-compaction context augmentation that enriches opencode's
    continuation prompt with cavemem-derived context (recent
    decisions, current focus, references the agent must preserve).
  - A manual `/compact` slash command that wraps opencode's native
    compaction trigger for operator- or agent-initiated use.
  - A steering document that documents when, why, and how to compact,
    what context is preserved across compaction, and how to debug
    carry-over outcomes.
  - An optional opt-in mechanism to extend automatic triggering to
    long-running subagent sessions in addition to main-thread
    sessions, including an allowlist by agent type.
  - Declarative install across both nix-darwin hosts via the project's
    existing module pattern, with host parity.
  - An observability surface so the operator can correlate compaction
    events with cost reductions in the existing cost diagnostic.
  - Reversibility: trivially disable-able via the install module with
    zero residual side effects.

- **Out of scope**:
  - Replacing or rewriting opencode's compaction machinery. The plugin
    triggers and augments; it does not summarize.
  - Per-tool output compression at the source (separate deferred spec
    `tool-output-compressor`).
  - Subagent prompt slimming or per-agent-type tool allowlists
    (separate in-flight brief `subagent-context-budget`).
  - Modular AGENTS.md, MCP server allowlisting, prompt-caching
    enablement (separate deferred specs).
  - A new cavemem CLI subcommand, schema change, or MCP tool. Cavemem
    stays read-only for the lifetime of this spec.
  - Cross-session forking / resume orchestration. The operator
    continues to manage `--continue --fork` themselves.
  - A persistent live-cost logger plugin. That capability still
    belongs to the cost diagnostic's backlog.
  - Modifications to opencode source or any opencode-managed
    configuration files.
  - Cost dashboards, web UIs, hosted services, or external SaaS
    observability.
  - Cost forecasting, anomaly detection, or runtime cost predictions.

- **Adjacent expectations**:
  - **opencode**: provides the native compaction surface
    (pre-compaction hook, post-compaction event, programmatic
    compaction trigger) and per-turn token events that the plugin
    consumes. The plugin uses opencode's existing experimental APIs
    and must fail loudly if those APIs change.
  - **opencode-cost-diagnosis**: provides the baseline measurement
    that motivated the spec and the validation harness for before/
    after comparison. The cost diagnostic must remain runnable
    independently; this spec does not block on extending it.
  - **cavemem**: provides read-only context retrieval via existing
    CLI and MCP search and observation surfaces. This spec consumes
    those reads; it does not write to cavemem and does not require
    any cavemem schema or CLI extension.
  - **`subagent-context-budget` (in-flight brief)**: complementary;
    bounds per-dispatch overhead. This spec bounds long-session
    accumulation. The two specs may compose if subagent-watch is
    enabled.
  - **`tool-output-compressor` (deferred)**: complementary; bounds
    bytes per tool output at the source. This spec bounds N turns
    of accumulated output. The two compose without coupling.
  - **Three open design-phase decisions** are explicitly bracketed
    rather than pre-decided:
    1. Which opencode event carries per-turn token data. Requirements
       specify "the plugin tracks token growth on each LLM turn"; the
       event choice is a design-phase decision.
    2. Whether subagent sessions emit observable per-turn token
       events. Requirements specify that when subagent-watch is
       enabled, the plugin applies threshold logic; design must
       confirm the observability surface exists.
    3. Threshold default values (tokens, wall time, growth rate).
       Requirements specify operator-configurable thresholds with
       sensible defaults; specific numbers are a design-phase
       decision grounded in the cost diagnostic's data.

## Requirements

### Requirement 1: Plugin distribution and host availability

**Objective:** As the operator of this nix-config (sole user across
two nix-darwin hosts), I want the session-compaction plugin to install
identically on both hosts via the project's existing declarative
install pattern, so the same compaction behavior runs on either host
without per-host tweaks.

#### Acceptance Criteria

1. The session-compaction feature shall install on both the Shopify
   and personal nix-darwin hosts via the project's existing
   declarative install pattern, without requiring per-host
   configuration to enable the plugin.
2. When the operator runs the host's standard rebuild command with
   the feature enabled, the install module shall make the plugin
   active for the next opencode invocation without further manual
   steps.
3. If the session-compaction feature is enabled but a peer module it
   depends on is not enabled at the same time, the system shall fail
   at configuration-evaluation time with an actionable error that
   names the missing peer and the action required.
4. The session-compaction feature shall not require any imperative
   install step, network fetch at runtime, or post-install bootstrap
   on either host.
5. The install module shall expose an explicit disable option.
6. When the operator sets the disable option and re-runs the
   rebuild command, the install module shall remove the plugin from
   the active opencode plugin set, and subsequent opencode sessions
   shall exhibit no residual session-compaction behavior.

### Requirement 2: Threshold-driven automatic compaction

**Objective:** As the operator, I want long-running opencode sessions
to be automatically compacted when configurable thresholds are crossed,
so that no session accumulates context indefinitely and the 30-day
session cost pattern observed in the 2026-05-19 diagnostic is
structurally prevented.

#### Acceptance Criteria

1. The plugin shall track per-session token accumulation across the
   lifetime of each opencode session it observes.
2. The install module shall expose at least one operator-configurable
   token-count threshold.
3. When the accumulated token count for an observed session exceeds
   the configured token-count threshold, the plugin shall invoke
   opencode's native compaction mechanism for that session.
4. The install module shall expose at least one operator-configurable
   wall-clock threshold.
5. When the wall-clock duration since the start of observation (or
   since the most recent compaction event) for an observed session
   exceeds the configured wall-clock threshold, the plugin shall
   invoke opencode's native compaction mechanism for that session.
6. The install module shall expose an operator-configurable cooldown
   window between successive automatic compactions of the same
   session.
7. While the cooldown window for a session has not elapsed since the
   last compaction event, the plugin shall not invoke automatic
   compaction for that session.
8. Where a configurable threshold is set to a disabled value (such
   as zero, null, or unset), the plugin shall not use that threshold
   to trigger compaction.
9. If opencode's native compaction mechanism is unavailable or
   returns an error when the plugin invokes it, the plugin shall
   record the failure and leave the session unchanged rather than
   block opencode's main loop.
10. The plugin shall not invoke automatic compaction on a session
    that has produced zero LLM turns since the start of observation.

### Requirement 3: Continuation prompt augmentation from cavemem

**Objective:** As the operator (and the agents running in the
session), I want opencode's continuation prompt to be enriched with
prior-session context retrieved from cavemem, so that information the
agent must preserve across compaction (open todos, recent decisions,
current focus) survives the summary opencode generates.

#### Acceptance Criteria

1. When opencode signals that a session is about to undergo
   compaction, the plugin shall query cavemem's read surface for
   high-signal context tied to that session.
2. When cavemem returns relevant context for the compacting session,
   the plugin shall augment opencode's continuation prompt with that
   context so opencode's native summarization incorporates it.
3. If cavemem is unreachable, returns no relevant content, or
   returns an error, the plugin shall let opencode's compaction
   proceed without augmentation rather than block or fail
   compaction.
4. The plugin shall not write to cavemem during compaction; cavemem
   access shall be read-only throughout the compaction flow.
5. The plugin shall not replace opencode's native summary content;
   it shall only augment the inputs opencode uses to generate that
   summary.
6. While the operator disables the augmentation via an install
   module option, the plugin shall still invoke compaction on
   threshold trips but shall skip the cavemem query and inject
   nothing into opencode's continuation prompt.

### Requirement 4: Manual compaction surface

**Objective:** As the operator or an agent in the session, I want a
manual command that forces compaction without waiting for the
threshold to trip, so I can compact proactively before a known-
expensive phase or recover from a misconfigured threshold.

#### Acceptance Criteria

1. The feature shall expose a slash command in opencode sessions
   for forcing compaction.
2. When the operator or an agent invokes the slash command, the
   system shall trigger opencode's native compaction mechanism for
   the current session.
3. When the slash command triggers compaction, the augmentation
   behavior defined in Requirement 3 shall apply identically to
   manual and automatic compaction.
4. If the slash command is invoked on a session that has produced
   zero LLM turns since its last compaction event, the system
   shall return a clear message indicating there is nothing to
   compact and shall not invoke compaction.
5. If the slash command's underlying compaction call fails, the
   system shall surface the failure to the operator with a message
   clear enough to act on, and shall not silently no-op.
6. The feature shall provide a steering document at
   `.kiro/steering/session-compaction.md` that documents when to
   use manual compaction, what context is preserved across
   compaction, and how to inspect or debug carry-over outcomes.

### Requirement 5: Optional subagent-watch coverage

**Objective:** As the operator, I want the option to extend automatic
threshold logic to long-running subagent sessions, so that the rare
subagent that runs for hours (such as a deep investigation) is also
protected from unbounded context accumulation, without changing the
default behavior.

#### Acceptance Criteria

1. The install module shall expose a subagent-watch opt-in option
   that defaults to disabled.
2. While subagent-watch is disabled, the plugin shall apply
   threshold logic only to main-thread (non-subagent) opencode
   sessions.
3. Where subagent-watch is enabled, the plugin shall apply the
   same threshold and cooldown logic from Requirement 2 to subagent
   sessions whose accumulated tokens or wall-clock duration cross
   the configured thresholds.
4. The install module shall accept an operator-supplied subagent-type
   allowlist.
5. Where subagent-watch is enabled and an allowlist is supplied, the
   plugin shall apply threshold logic only to subagent sessions
   whose agent type matches an entry in the allowlist.
6. If the underlying opencode event surface does not expose
   per-turn token data for subagent sessions, the plugin shall log
   a one-time warning at startup when subagent-watch is enabled and
   shall continue to operate on main-thread sessions without
   failure.

### Requirement 6: Observability of compaction events

**Objective:** As the operator, I want compaction events to be
observable so I can correlate them with cost reductions in the
existing cost diagnostic and debug cases where carry-over went wrong.

#### Acceptance Criteria

1. When the plugin triggers automatic compaction, the plugin shall
   record a compaction event recoverable by the existing cost
   diagnostic so a re-run of the diagnostic can surface the event
   for the affected session.
2. When the plugin augments a continuation prompt via Requirement 3,
   the plugin shall record the augmentation event, including a
   reference to the source of the augmenting context, such that the
   operator can later determine what was injected.
3. The plugin shall write its operational log to a path that
   survives the opencode session and is locatable from the install
   module's documentation.
4. When automatic compaction is suppressed for any reason (cooldown
   active, threshold disabled, opencode mechanism unavailable, zero
   LLM turns since start of observation), the plugin shall record
   the suppression reason in its operational log.
5. The plugin shall record startup, shutdown, and configuration
   values in effect for each opencode session so the operator can
   later confirm the active threshold values during any historical
   session.

### Requirement 7: Compatibility with opencode's compaction APIs

**Objective:** As the operator, I want the plugin to fail loudly
rather than silently when opencode's experimental compaction APIs
change incompatibly, so that I am not paying for compaction-induced
regressions or silent no-ops.

#### Acceptance Criteria

1. The install module shall declare a supported opencode version
   range that the plugin has been validated against.
2. When opencode starts a session with the plugin enabled, the
   plugin shall execute a startup self-check confirming that the
   opencode hooks and APIs it depends on are present and have the
   expected shape.
3. If the startup self-check fails, the plugin shall log an
   actionable error naming the missing or changed surface and shall
   disable itself for the session rather than block opencode
   startup.
4. While disabled by a failed self-check, the plugin shall not
   invoke compaction, augment continuation prompts, or interfere
   with opencode's own compaction logic.
5. If opencode's compaction mechanism produces an error at runtime,
   the plugin shall record the error in its operational log and
   shall not retry the same compaction within the cooldown window.
6. The session-compaction feature shall not modify opencode source
   or any opencode-managed configuration files; the install module
   shall use only the project's existing opencode plugin install
   surface.

### Requirement 8: Composition with adjacent specs

**Objective:** As the operator, I want session-compaction to compose
cleanly with `opencode-cost-diagnosis`, the in-flight
`subagent-context-budget` brief, and the deferred `tool-output-
compressor` spec, so I can ship each independently without breaking
the others.

#### Acceptance Criteria

1. The session-compaction feature shall remain runnable while the
   opencode-cost-diagnosis CLI is also installed and enabled on the
   same host.
2. When the cost diagnostic is re-run after compaction events have
   occurred, the diagnostic shall continue to load and produce its
   usual report sections without error caused by the compaction
   events themselves.
3. The session-compaction feature shall not require any change to
   the subagent-context-budget brief's existing scope (per-agent
   tool allowlists, per-agent AGENTS.md overrides); if
   subagent-context-budget ships, the two features shall coexist on
   the same host with no install-time conflict.
4. The session-compaction feature shall not require any cavemem
   CLI, schema, or MCP surface changes; if those changes ever land
   upstream, session-compaction shall continue to work using only
   the read surface available today.
5. Where a future tool-output-compressor spec lands, session-
   compaction's threshold logic shall continue to apply correctly
   to the compressed tool outputs as observed by the plugin,
   without re-tuning the plugin's interface.

### Requirement 9: Validated cost-reduction impact

**Objective:** As the operator, I want to verify that session-
compaction actually reduces LLM API spend on the workloads that
motivated the spec, so I can confirm the intervention is worth its
operational complexity.

#### Acceptance Criteria

1. When session-compaction is enabled on a representative workload
   comparable in shape to the 27 long-running sessions identified
   in the 2026-05-19 cost diagnostic, a subsequent re-run of the
   cost diagnostic shall show a measurable reduction in the
   `accumulatedToolOutputsCached` sub-bucket compared to the
   pre-enablement baseline on that workload.
2. The validation workload and methodology shall be documented
   alongside the install module so the measurement can be repeated
   whenever thresholds or augmentation logic change.
3. While session-compaction is enabled at default thresholds, the
   system shall not allow any new session to reach the cost profile
   of the 30-day outlier session
   (`ses_2851d6bfcffeIyWxzo6c8AXVo5`, approximately $1,567 in v1
   cost terms) without at least one compaction event having
   occurred for that session.
4. If a validation run shows session-compaction did not reduce the
   targeted sub-bucket compared to baseline, the operator shall
   record the finding and either retune the configurable thresholds
   or revisit the design before considering the feature complete.
