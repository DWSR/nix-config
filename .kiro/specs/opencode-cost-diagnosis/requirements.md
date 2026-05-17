# Requirements Document

## Introduction

The diagnostic is a locally-installed CLI that reads opencode's session
database read-only and emits a per-component cost-attribution report
(Markdown + JSON) so the operator can rank candidate cost-reduction
interventions by evidence rather than gut feel. It runs identically on
both nix-darwin hosts (Shopify and personal), produces the same report
shape on each, and is durable -- it stays installed and gets re-run
after every cost-reduction intervention as the success-measurement
primitive. The four attribution categories the report breaks down are:
system prompt (split into Anthropic prompt-cache reads vs uncached
prefix tokens), conversation history, tool outputs, and subagent
dispatches. The diagnostic itself does NOT change opencode's behavior
or implement any cost reduction; cost reductions become follow-on
specs informed by what the diagnostic surfaces.

## Boundary Context

- **In scope**:
  - A CLI that produces Markdown + JSON cost-attribution reports per
    session and per project (cwd-grouped) for opencode usage on a
    single host.
  - A four-category attribution breakdown (system-prompt cached,
    system-prompt uncached, conversation history, tool outputs,
    subagent dispatches) for each session in scope of the report.
  - Time-range, per-session, and per-project (cwd) selection.
  - Default-exclude privacy posture for message bodies and tool-output
    content, with an explicit content-disclosure opt-in flag.
  - Schema-drift detection against a pinned supported opencode version
    range, with loud failure on out-of-range schemas and graceful
    warnings on partial-data conditions.
  - Read-only access to opencode's session database; concurrent-safe
    with active opencode sessions.
  - Multi-host parity: identical CLI install and identical report
    shape on both Shopify and personal nix-darwin hosts via the
    project's existing declarative install pattern.
  - A binary design-phase decision on whether the optional live-logger
    plugin ships in v1 OR is explicitly deferred with a named trigger
    condition.

- **Out of scope**:
  - Any cost-reduction intervention itself (prompt-caching enablement,
    MCP allowlist, AGENTS.md modularization, session compaction,
    tool-output compression, rtk install, model routing, etc.); these
    become follow-on specs informed by this diagnostic's output.
  - Real-time dashboards, web UIs, or hosted services.
  - Cross-host data merge or shared aggregation across hosts.
  - Anthropic Admin Cost Report API integration as the primary data
    source (its daily granularity makes it useful only as a
    cross-check on monthly totals).
  - Cost forecasting, anomaly detection, or comparison reports between
    runs (diffing two JSON reports is a future convenience, not in
    v1).
  - Per-host backup wiring of the source database (the Shopify host
    is already wired; personal-host wiring is deferred per the
    cavemem precedent and is not gated on this spec).
  - Replacing opencode's own in-session usage display.
  - Helicone or Langfuse integration.

- **Adjacent expectations**:
  - **opencode**: the diagnostic is a read-only consumer of opencode's
    session database. The diagnostic must never write to that database
    and must remain functional while opencode sessions are active. The
    diagnostic depends on opencode populating the per-turn token
    counters and prompt-cache fields it already records.
  - **sqlite-backup**: provides durability for the source database
    where wired. Loss of session history degrades the diagnostic's
    historical baseline but does not affect the diagnostic's
    correctness on whatever data the local database still holds.
  - **Anthropic prompt-caching**: the diagnostic reports the
    cached/uncached split using values opencode surfaces from
    Anthropic responses. If opencode is not exercising prompt
    caching, the diagnostic reports a zero cached bucket and
    surfaces that as a finding rather than as an error.
  - **Follow-on cost-reduction specs** (catalogued under "Deferred
    Specs" in `.kiro/steering/roadmap.md`): each consumes the
    diagnostic's output as its success-measurement primitive. The
    diagnostic's report shape must be stable enough across runs that
    a before/after diff is meaningful.
  - **Two open design-phase decisions** are explicitly bracketed in
    these requirements rather than pre-decided:
    1. **Tool-output token attribution method** (delta-from-next-turn
       vs re-tokenize the `part` rows): requirements specify the
       observable output (a tool-outputs bucket per turn) without
       prescribing the technique.
    2. **Live-logger plugin in v1**: requirements specify the
       diagnostic works without the plugin (always-true) and what
       the plugin does if design includes it (Where-clause), and
       require design to record an explicit binary decision (see
       Requirement 7).

## Requirements

### Requirement 1: CLI distribution and host availability

**Objective:** As the operator of this nix-config (sole user across two
nix-darwin hosts), I want the diagnostic to install identically on
both hosts via the project's existing declarative install pattern, so
the same baseline measurement runs on either host without per-host
tweaks.

#### Acceptance Criteria

1. The diagnostic shall install on both the Shopify and personal
   nix-darwin hosts via the project's existing declarative install
   pattern, without requiring per-host configuration to enable the
   CLI on either host.
2. When the operator runs the host's standard rebuild command with
   the diagnostic enabled, the diagnostic shall expose a single
   stable CLI entry-point name on PATH that the operator can invoke
   directly.
3. If the diagnostic is enabled but a peer module it depends on is
   not enabled at the same time, the system shall fail at
   configuration-evaluation time with an actionable error message
   that names the missing peer and the action required.
4. The diagnostic shall not require any imperative install step,
   network fetch at runtime, or post-install bootstrap on either
   host.
5. When the operator invokes the diagnostic on either host, the
   diagnostic shall present the same command-line surface
   (subcommands, flags, exit codes, output format) on both hosts.

### Requirement 2: Cost-attribution report content

**Objective:** As the operator, I want each report to break opencode
session input-token consumption into the four attribution categories,
so I can identify which category dominates my actual workflow and
rank follow-on cost-reduction interventions by evidence.

#### Acceptance Criteria

1. When the operator invokes the diagnostic without selection
   filters, the diagnostic shall produce a Markdown report covering
   all sessions present in the local opencode session database.
2. When the operator invokes the diagnostic without selection
   filters, the diagnostic shall also produce a JSON report
   containing the same data as the Markdown report, suitable for
   diffing across runs.
3. The diagnostic shall attribute each assistant turn's input tokens
   into the following five buckets, each reported separately:
   (a) system-prompt cached prefix tokens,
   (b) system-prompt uncached prefix tokens,
   (c) conversation-history tokens,
   (d) tool-output tokens,
   (e) subagent-dispatch tokens.
4. The diagnostic shall report per-session totals for each bucket and
   an aggregate total across all sessions in the report.
5. The diagnostic shall report per-project totals (grouped by the
   session's working directory) for each bucket.
6. The diagnostic shall report monetary cost per session and per
   project using the per-turn cost field opencode already populates.
7. While Anthropic prompt-caching is not being exercised by opencode
   (i.e. all per-turn cached-prefix counters in the source data are
   zero), the diagnostic shall report the cached-prefix bucket as
   zero and shall surface this as a notable finding in the report
   rather than as an error.
8. When the local opencode session database contains no sessions in
   scope of the report, the diagnostic shall produce an
   empty-but-valid Markdown report and an empty-but-valid JSON
   report, and shall exit successfully.
9. When the diagnostic produces a report whose attribution includes
   the three uncached-input sub-buckets ((b) system-prompt uncached,
   (c) conversation history, (d) tool outputs), the diagnostic shall
   include in both the Markdown and the JSON report a structured
   accuracy disclaimer that states (i) the tokenizer used and its
   encoding, (ii) the specific buckets whose values are derived from
   the tokenizer rather than from opencode's authoritative stored
   counters, (iii) that the affected bucket values are relative-only
   estimates suitable for ranking cost drivers and are not
   billing-grade absolute counts, and (iv) that the bucket totals
   nevertheless sum exactly to opencode's stored authoritative
   uncached-input value. The disclaimer shall be present in every
   report run that includes these buckets, regardless of report
   format or invocation flags.

### Requirement 3: Selection and filtering

**Objective:** As the operator, I want to scope reports to a specific
time window, session, or project, so I can investigate individual
cost spikes without re-aggregating the entire history.

#### Acceptance Criteria

1. When the operator passes a time-range selector to the diagnostic,
   the diagnostic shall include only sessions whose activity falls
   within the specified range.
2. When the operator passes a session-identifier selector to the
   diagnostic, the diagnostic shall produce a report containing
   exactly the matching session.
3. When the operator passes a project (working-directory) selector
   to the diagnostic, the diagnostic shall include only sessions
   whose recorded working directory matches the selector.
4. When the operator combines multiple selectors in a single
   invocation, the diagnostic shall apply them as a logical AND.
5. If the operator passes an unknown selector argument or an
   unparseable selector value, the diagnostic shall exit with a
   non-zero status and shall print an actionable stderr message
   that names the offending argument.

### Requirement 4: Privacy and content disclosure

**Objective:** As the operator, I want report output to default to
non-sensitive metadata so I can share or commit a report without
inadvertently leaking conversation content, with an explicit opt-in
for full content when I am debugging.

#### Acceptance Criteria

1. The diagnostic shall, by default, emit reports that contain only
   the following per-session fields visible to the human reader:
   session identifier, working directory path, time range, model
   name, per-bucket token totals, and per-turn monetary cost.
2. The diagnostic shall, by default, exclude all message bodies,
   tool-output content, and prompt content from both the Markdown
   and JSON outputs.
3. Where the operator passes a content-disclosure opt-in flag, the
   diagnostic shall include the additional content fields it would
   otherwise omit.
4. When the diagnostic writes any report file to disk, the
   diagnostic shall set the file mode so the report is readable only
   by the operator who invoked it and not by other local users.
5. The diagnostic shall write report files only under an
   operator-controlled output location, defaulting to a path under
   the operator's XDG state directory, and shall not write to
   system-wide or world-writable paths.

### Requirement 5: Schema-drift detection and graceful degradation

**Objective:** As the operator, I want the diagnostic to detect when
opencode's database shape has changed in a way that would cause
silent miscounting, so I can update the diagnostic before trusting
any report.

#### Acceptance Criteria

1. The diagnostic shall record the supported opencode version range
   explicitly within the diagnostic itself, such that the operator
   can read the supported range from the diagnostic without
   consulting external documentation.
2. When the diagnostic opens an opencode database whose shape is
   outside the supported version range, the diagnostic shall fail
   with a non-zero exit code and a stderr message naming the
   detected version, the supported range, and a recommended next
   action.
3. While the diagnostic detects that the opencode database is
   missing a link between subagent sessions and their dispatching
   session, the diagnostic shall continue and shall attribute
   subagent-dispatch tokens to the dispatching session conservatively,
   and shall surface this partial attribution as a notable finding in
   the report.
4. While the diagnostic detects any other recoverable schema
   condition that affects only a subset of the attribution buckets
   (for example, an expected field populated only on newer opencode
   versions), the diagnostic shall continue and shall surface the
   affected attribution categories as notable findings in the report
   rather than failing.

### Requirement 6: Read-only safety and idempotence

**Objective:** As the operator, I want repeated runs against the same
source data to produce the same output and to never risk corrupting
the live opencode database, so I can use the diagnostic safely while
opencode sessions are active.

#### Acceptance Criteria

1. The diagnostic shall not write to, modify, or otherwise mutate the
   opencode session database under any invocation.
2. When the diagnostic runs concurrently with an active opencode
   session writing to the database, the diagnostic shall complete its
   read without blocking the session and without the session blocking
   the diagnostic.
3. When the diagnostic is invoked twice with identical arguments and
   an unchanged source database, the diagnostic shall produce
   byte-identical JSON output. (Markdown output may differ only in
   non-semantic fields such as wall-clock report-generation
   timestamps, if those are emitted at all.)
4. If the diagnostic cannot find the opencode session database at the
   expected path, the diagnostic shall exit with a non-zero status
   and shall print an actionable stderr message that names the
   expected path.
5. If the diagnostic encounters an unrecoverable I/O error while
   reading source data or writing report output, the diagnostic
   shall exit with a non-zero status and shall print an actionable
   stderr message that names the affected file path and the nature
   of the error.

### Requirement 7: Optional live-logger plugin

**Objective:** As the operator, I want either to receive a
continuously-updated event stream of cost data via an opencode plugin
OR to know unambiguously that this stream is deferred to a later
spec, so I am never left with an undecided gap between turn-end and
the next manual diagnostic run.

#### Acceptance Criteria

1. The diagnostic shall produce its full Markdown and JSON report
   without requiring any opencode plugin to be installed.
2. Where the live-logger plugin is included in the v1 deployment,
   the live-logger plugin shall write structured cost events to a
   separate log file on each opencode lifecycle event that completes
   an assistant turn, without modifying the opencode session
   database.
3. Where the live-logger plugin is included in the v1 deployment,
   the live-logger plugin shall apply the same default-exclude
   content posture as the diagnostic itself: message bodies and
   tool-output content shall be excluded from the log file unless
   the operator explicitly opts in.
4. Where the live-logger plugin is included in the v1 deployment,
   the live-logger plugin shall write its log file under the
   operator's XDG state directory with the same per-user permission
   posture the diagnostic uses for its report files.
5. The design document for this spec shall include an explicit
   binary decision on whether the live-logger plugin ships in v1.
   Where the plugin is deferred, the design document shall name the
   trigger condition under which the plugin would be revisited.
