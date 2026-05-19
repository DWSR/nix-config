# Brief: session-compaction

## Problem

Long-running opencode sessions accumulate context across turns without
bound. Per the 2026-05-19 cost diagnostic (129 sessions, $7,694.92
total spend over ~30 days):

- **27 sessions ran >24h wall time** and together account for **67% of
  post-exclusion spend** ($4,104 of $6,128 once the single 30-day
  outlier is removed).
- The 30-day outlier alone — one nix-config session that ran
  2026-04-11 → 2026-05-10 — cost **$1,566.86 (20.4% of all spend)**
  before pricing-table drift nulled its per-bucket attribution.
- Inside the cachedRead bucket (which is 41% of post-exclusion spend),
  **`accumulatedToolOutputsCached` = 89%** and
  `accumulatedHistoryCached` = 11%. Once context lands in cachedRead,
  every subsequent turn pays to re-read it. Long sessions therefore
  pay the accumulated-context tax linearly in turn count.

The pattern is structural: opencode keeps the session alive across
days, every turn re-reads every prior turn's output via the cache,
and nothing prunes the accumulating context. Users (and agents) have
no automatic backstop — only manual discipline, which the cost data
shows is unevenly applied.

A "tool-output-compressor" spec (deferred) addresses the byte size
of each individual output at the source. This spec addresses the
orthogonal problem: even with small individual outputs, *N turns of
small outputs* across a multi-day session still accrete into a large
cached context. Compaction is the bound on N.

## Current State

- **opencode already supports compaction natively**, but no automatic
  triggering is wired in this repo:
  - `experimental.session.compacting` plugin hook fires BEFORE the
    LLM generates a continuation summary; plugins can inject context
    via `output.context.push(...)` or replace the prompt via
    `output.prompt`.
  - `session.compacted` event fires AFTER compaction completes.
  - `session.summarize({ path, body })` SDK method programmatically
    triggers compaction.
  - CLI flags `-c/--continue`, `-s/--session <id>`, `--fork` provide
    native session resume / fork.
  - **No plugin in this repo subscribes to any of the above today.**
- **Two existing opencode plugins** demonstrate the install pattern:
  - `home-manager/common/opencode-plugins/cavemem.js` — hooks
    `session.created`, `session.idle`, `tool.execute.before/after`.
    Installed via `xdg.configFile."opencode/plugins/cavemem.js"` at
    `home-manager/common/cavemem.nix:380`.
  - `home-manager/common/opencode-plugins/zellij-attention.ts` — uses
    the generic `event` callback filtering on `event.type`.
    Installed at `home-manager/common/default.nix:201-202`.
- **cavemem already captures every prompt, response, and tool call**
  per session (the existing plugin's hook surface, plus the
  `cavemem hook run …` CLI subcommand). The data needed to *augment*
  opencode's continuation prompt with prior-session context already
  exists; we just don't read it back during compaction.
- **opencode-cost-diagnosis exposes a CommonJS library** that a plugin
  can `require()` (`SqliteReader`, `AttributionEngine`, etc., per
  `scripts/opencode-cost-report.js:5127-5175`) — useful if the
  trigger logic wants richer cost info than the `message.updated`
  payload alone provides.
- **No common slash-command surface in HM**: the Shopify host
  declares commands at
  `configurations/shopify/home-manager/opencode.nix:84-88`; the
  common opencode module doesn't expose `programs.opencode.commands`
  today. A new shared `/compact` slash command requires either
  promoting the common option or contributing per-host.
- **Skills are vendored via `pkgs.cc-sdd-skills`** but the cc-sdd HM
  module deliberately allows per-skill `xdg.configFile` additions
  (`home-manager/common/cc-sdd.nix:69-76` comment). A new
  `kiro-session-compact` skill (if desired) can be authored locally
  without forking cc-sdd.

## Desired Outcome

After this spec lands and a representative workload is re-run, the
opencode-cost-diagnosis report shows a meaningful reduction in
`accumulatedToolOutputsCached + accumulatedHistoryCached` per
long-running session, and the long-session-count pattern (currently
27 sessions >24h = 67% of spend) collapses.

Concretely:

- An opencode plugin watches per-turn token growth and triggers
  opencode's native compaction (`session.summarize` or equivalent)
  when configurable thresholds trip (token count, wall time,
  rate-of-growth — exact thresholds picked in design phase).
- The plugin uses the `experimental.session.compacting` hook to
  augment opencode's native continuation prompt with cavemem-derived
  context (e.g., recent decisions, current focus, references the
  agent must preserve across compaction).
- A `/compact` (and possibly `/carryover`) slash command lets the
  human or agent force compaction without waiting for the threshold.
- A steering doc documents the protocol so subagents and humans both
  know when to trigger manual compaction, how to inspect what was
  carried over, and how to debug a "lost-too-much" or "kept-too-much"
  case.
- **Target**: ≥40% reduction in `accumulatedToolOutputsCached` per
  long-session-replay workload, no functional regression (agents
  still complete their declared tasks; carry-over digest preserves
  the references they need).
- **No 30-day-session pattern survives** at the configured thresholds:
  any session that would have exceeded $500 in v1's cost terms gets
  at least one compaction event before that point.

## Approach

**Approach A′: piggyback on opencode's native compaction, augment via
cavemem.** Plugin role is thin and well-bounded:

1. **Trigger logic** (plugin). Subscribe to `message.updated` (or
   `message.part.updated` filtered on `part.type == "step-finish"`
   — exact event picked in design phase based on payload shape).
   Track per-session running token totals. When a configurable
   threshold trips (`thresholdTokens`, `thresholdWallTimeHours`,
   `thresholdGrowthRate`), call `session.summarize()` via the SDK to
   programmatically invoke opencode's native compaction.

2. **Context augmentation** (plugin). Subscribe to
   `experimental.session.compacting`. When the hook fires (whether
   from our trigger or from opencode's own logic), query cavemem
   (`hub_cavemem__search` / `timeline` / `get_observations` or the
   CLI equivalent) for high-value context from the current session —
   decisions made, files touched, open todos, current focus — and
   push it into `output.context` so opencode's continuation summary
   incorporates the augmented context.

3. **Manual surface** (skill + slash command + steering). Ship a
   `/compact` slash command (wraps `session.summarize`) and a
   steering doc `.kiro/steering/session-compaction.md` documenting
   when to trigger, what gets preserved, what to do if compaction
   went wrong. Optionally a `kiro-session-compact` skill that
   formalizes the carry-over protocol for agents.

4. **HM wiring** (Nix). New module `home-manager/common/session-compaction.nix`
   exposes `programs.session-compaction.{enable, thresholdTokens,
   thresholdWallTimeHours, watchSubagents, …}`. Plugin file shipped
   via `xdg.configFile` mirroring the existing two plugins. Asserts
   `programs.opencode.enable`. Common-wide enable.

5. **Validation** (re-run diagnostic). Use the existing
   `opencode-cost-report` as before/after measurement. No new
   measurement primitive is introduced unless v2-diagnosis ships
   first (in which case use v2's per-tool / per-agent breakdown).

**Why this over the rejected alternatives**:

- Rejected: cavemem-anchored restart-with-digest. Reinvents
  opencode's native compaction (`session.summarize` + `--fork`),
  requires three upstream cavemem PRs (no `summarize` subcommand,
  no `summaries` table, no MCP read tools), and loses integration
  with opencode's TUI compaction flow.
- Rejected: in-place compaction parallel to opencode's. Same
  duplication risk; structurally inferior because we'd race
  opencode's own compaction logic and lose whenever the two
  disagreed.
- Rejected: workflow-only (no plugin). Depends entirely on
  discipline; the cost data shows that's exactly what fails
  today.

## Scope

- **In**:
  - opencode plugin that subscribes to `message.updated` (or
    `message.part.updated`) and `experimental.session.compacting`,
    triggers `session.summarize()` on configurable thresholds, and
    injects cavemem-derived context into opencode's continuation
    prompt.
  - HM module exposing `programs.session-compaction.{…}` options
    (enable, thresholds, subagent-watch opt-in, debug logging).
    Common-wide install, host-parity.
  - `/compact` slash command (wraps `session.summarize` via SDK) so
    humans and agents can force compaction manually.
  - Steering doc `.kiro/steering/session-compaction.md` documenting
    the protocol.
  - Optional `kiro-session-compact` skill if the agent-side protocol
    is non-trivial enough to warrant codification (design-phase
    decision).
  - Subagent-watch opt-in: HM option to apply threshold logic to
    long-running subagent sessions, not just main-thread.
  - Before/after validation via re-running `opencode-cost-report`.

- **Out**:
  - **Replacing or rewriting opencode's compaction machinery.** We
    use `session.summarize()` and `experimental.session.compacting`
    as opencode exposes them; we do not fork the binary, monkey-patch
    its summarization logic, or build a parallel summarizer.
  - **Per-tool output compression at the source**. That's
    `tool-output-compressor`'s scope (deferred). The two specs
    compose: this one bounds N (number of turns the context can
    accumulate before compaction); that one bounds bytes-per-turn.
  - **Subagent prompt slimming**. That's `subagent-context-budget`'s
    scope (in-flight brief at `.kiro/specs/subagent-context-budget/`).
    The two specs compose: this one bounds long-session accumulation;
    that one bounds per-dispatch overhead.
  - **AGENTS.md modularization** (deferred spec
    `agents-md-modularization`). Orthogonal: this spec doesn't
    touch the system-prompt content.
  - **A new cavemem CLI subcommand or schema change**. The viability
    check confirmed cavemem has no `summarize` and no `summaries`
    table; we deliberately do NOT take on that upstream surface.
    Cavemem stays a read-only augmentation source.
  - **Cross-session caching of prompts** (Anthropic doesn't support
    this; out of our control).
  - **Cost dashboards or web UIs**. The diagnostic remains
    Markdown/JSON.
  - **Automatic session forking / resume orchestration**. We trigger
    opencode's native compaction; we do NOT manage the new-session
    spawn or `--continue --fork` user flow (that's left as a
    follow-on workflow concern).
  - **A live-cost logger plugin** (still on the
    opencode-cost-diagnosis backlog as an optional v1 deliverable).
    Our plugin's token tracking is for trigger decisions only; if a
    persistent live log is wanted, it ships under cost-diagnosis.

## Boundary Candidates

The explore sub-agent identified five clean internal seams. The
design phase confirms or revises:

- **Trigger logic** (plugin): per-session token accounting + threshold
  evaluation + decision to call `session.summarize()`. Pure logic,
  testable without opencode.
- **Context augmentation** (plugin): the
  `experimental.session.compacting` handler that queries cavemem and
  builds the context to inject. Pure transform; testable with
  recorded cavemem fixtures.
- **HM wiring** (Nix): `home-manager/common/session-compaction.nix`
  module, plugin file under `home-manager/common/opencode-plugins/`,
  option schema, host-parity assertion. Mirrors
  `home-manager/common/opencode-cost-diagnosis.nix`.
- **Manual surface** (skill + slash command + steering): authored
  separately; testable as plain documentation. May or may not
  warrant a kiro skill; design phase decides.
- **Diagnostic re-run** (validation): exercising
  `opencode-cost-report` against a long-session-replay fixture
  before/after the plugin lands. May reuse the v1 / v2 diagnostic
  test harness.

## Out of Boundary

- New subagent types (`subagent-context-budget` may add some;
  not this spec)
- Subagent fan-out limits, parallelism caps, or cost circuit
  breakers (separate concern)
- Per-tool output compression (`tool-output-compressor` deferred
  spec)
- Per-agent-type tool allowlists (`subagent-context-budget`
  in-flight brief)
- AGENTS.md modular includes (`agents-md-modularization` deferred
  spec)
- MCP server allowlisting (`mcp-server-allowlist` deferred spec)
- Anthropic Admin Cost Report API integration (still out of scope
  per the roadmap's v1 constraint set)
- Helicone / Langfuse or other external SaaS observability
- Modifications to cavemem source (no `cavemem summarize` PR; no
  new tables; no new MCP tools)
- Modifications to opencode source

## Upstream / Downstream

- **Upstream**:
  - `opencode-cost-diagnosis` v1 — provides the baseline measurement
    used to size thresholds and validate impact. Required.
  - `v2-diagnosis` (concurrent spec) — **strongly preferred upstream**
    if it ships first. v2's per-tool and per-agent-type breakdown
    sharpens the validation step (we can see *which* tool outputs
    were trimmed by compaction). If v2 lands later, the spec uses
    v1's bucket-level reduction as the success criterion.
  - opencode's plugin runtime (`experimental.session.compacting`
    hook, `session.summarize` SDK, `message.updated` /
    `message.part.updated` events). **`experimental.` prefix is a
    risk vector** — opencode may change the signature. The spec
    plans for that explicitly (version-pin opencode-pinned, smoke
    test on the prewarm step, fail loudly on signature drift).
  - cavemem MCP/CLI read surface: `hub_cavemem__search`, `timeline`,
    `get_observations`, plus the underlying `cavemem search` CLI.
    Read-only.
  - HM module surface (`home.cavemem.dataDir`,
    `programs.opencode.enable`, `xdg.configFile` plugin install
    pattern).

- **Downstream** (likely consumers; all deferred):
  - `tool-output-compressor` — composes with this spec. If
    triggered later, the diagnostic's per-tool breakdown after
    compaction is the input that decides its scope.
  - `subagent-context-budget` (in-flight) — composes with this
    spec. If "watchSubagents" is enabled, this spec's trigger
    logic limits per-dispatch accumulation; that spec's trimming
    limits per-dispatch fresh-context overhead.
  - Future workflow changes to opencode session lifecycle
    management (auto-spawning new sessions on compaction, etc.)
    inherit the plugin and skill machinery introduced here.
  - Future `kiro-session-hygiene` or similar steering — the
    steering doc this spec ships may seed a broader hygiene
    protocol.

## Existing Spec Touchpoints

- **Extends**: `opencode-cost-diagnosis` (and `v2-diagnosis` if
  shipped first) — adds a session-level
  `compaction_event_emitted` finding kind or equivalent so the
  diagnostic can report on compaction frequency. Specifics decided
  in design phase; may be absorbed without a formal extension if
  the report can read compaction events from opencode's DB
  directly.
- **Adjacent**:
  - `subagent-context-budget` (in-flight brief, no spec.json yet) —
    different cost driver; orthogonal seam. Carve-out: subagent
    prompt trimming is theirs; long-session accumulation
    (including in long subagents, opt-in) is ours.
  - `tool-output-compressor` (deferred) — different cost driver
    (per-output byte size); composes with this spec.
  - `cavemem-integration` (tasks-generated) — pattern reference
    for the opencode plugin install and the cavemem hook surface.
    This spec consumes cavemem read tools; that spec defined the
    primary write surface.
  - `v2-diagnosis` (tasks-generated) — preferred upstream for
    sharper validation.

## Constraints

- **macOS-first** (nix-darwin on both Shopify and personal hosts).
- **Declarative install**: plugin file, HM module, slash command, and
  any optional skill all ship via Nix overlay + HM module, like all
  other opencode integrations in this repo. No imperative
  installers.
- **Host parity**: identical behavior on Shopify and personal hosts.
  Threshold defaults may differ if a host-specific rationale is
  documented (e.g., Shopify host runs heavier workloads), but the
  mechanism is identical.
- **No agent rewrites**: the plugin observes events and triggers
  the native compaction SDK call. It does NOT modify agent
  definitions, AGENTS.md, MCP server lists, or any other
  prompt-shaping surface.
- **No upstream cavemem changes**: viability check confirmed that
  taking on cavemem's `summarize` surface is a 3-PR upstream cost.
  The spec deliberately avoids it. Cavemem is a read-only
  augmentation source.
- **`experimental.` API risk**: `experimental.session.compacting`
  may change. Spec must (a) pin a known-good opencode version
  range in the HM module, (b) include a startup smoke test that
  fails loudly if the hook isn't wired correctly, (c) document
  the rollback path (disable the plugin via HM, opencode
  continues to work).
- **Reversible**: plugin must be trivially disable-able via HM
  module option. Disabling must restore the pre-compaction
  behavior with zero side effects on the session DB or cavemem
  data.
- **No regression in agent capability**: compacted sessions must
  still complete their declared tasks. Validation includes at
  least one long-session replay (or representative synthetic
  workload) confirming the agent retains the references it needs
  after compaction.
- **No new external SaaS dependency** (no Helicone, Langfuse,
  etc.).

## Open questions for design phase

The viability check left three assumptions unverified. The design
phase MUST resolve them before implementation:

1. **`message.updated` payload shape** — does the event carry
   per-turn `tokens.{input, output, cache.{read, write}}`, or only
   message text? Research notes claim the former but no in-tree
   plugin subscribes. Alternative: use `message.part.updated`
   filtered on `part.type == "step-finish"`. Resolve by reading
   `packages/sdk/js/src/gen/types.gen.ts` in opencode upstream
   OR by attaching a throwaway plugin to a live session and
   logging payloads.
2. **`message.updated` on subagent sessions** — does the event
   fire on subagent sessions, and what session ID is in the
   payload? Bears directly on the "watchSubagents" opt-in. Same
   resolution path as (1).
3. **Threshold defaults** — what are the right values for
   `thresholdTokens` and `thresholdWallTimeHours`? Empirical:
   pick conservative defaults that would have triggered at
   least one compaction event in the 27 >24h sessions from the
   2026-05-19 diagnostic, without triggering on healthy short
   sessions. Sanity-check against the v2 diagnostic if available.
