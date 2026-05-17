# Gap Analysis: opencode-cost-diagnosis

Generated: 2026-05-16

This document maps the approved requirements (`requirements.md`) against
the existing nix-config codebase and against external technical
realities (opencode's session DB schema, Anthropic prompt-cache
semantics, available Node tokenizers). It identifies what already
exists, what is missing, the implementation-approach options, the
material tradeoffs, and the research items design phase must close.

Critical findings up front:

1. **The 5-bucket split in R2.AC3 is not directly recoverable from
   opencode's stored aggregates.** opencode persists per-session
   `tokens_input`, `tokens_cache_read`, `tokens_cache_write`,
   `tokens_output`, `tokens_reasoning`, and `cost`, plus a granular
   per-`step-finish` part. But uncached input (system prompt +
   conversation history + tool outputs) is a single bucket in the DB;
   splitting those three requires reconstructing each prompt from
   `part` rows in time order and re-tokenizing each chunk.

2. **The Claude-4 tokenizer story is poor.** The official
   `@anthropic-ai/tokenizer` (npm) was last published 2023-07-05 and
   ships only the Claude-2-era BPE; it under-counts Claude
   Opus/Sonnet 4.x by an estimated ~15%. The authoritative
   `messages.count_tokens` API is per-request and rate-limited (no
   bulk retro). This is the dominant accuracy risk for the diagnostic.

3. **Subagent attribution is structurally clean.** `session.parent_id`
   is a real, indexed column in opencode's schema (verified live: 517
   of 637 sessions on the Shopify host carry a non-null parent_id).
   A recursive CTE walks the dispatch tree. No double-counting:
   subagent token totals are disjoint from their dispatching session's
   totals.

4. **better-sqlite3 build is a solved precedent.** `cavemem-importer-
   deps` already vendors `better-sqlite3@12.10.0` with the correct
   Darwin build flags (`npm_config_build_from_source=true`,
   `darwin.apple_sdk.frameworks.CoreServices`). The diagnostic
   reuses this exact pattern.

5. **The most defensible v1 may be narrower than R2.AC3 currently
   specifies.** Design phase should explicitly choose among three
   ambition levels (aggregates-only / aggregates + re-tokenization /
   full re-tokenization with API cross-check) and surface to the user
   whether R2.AC3's 5-bucket promise needs to be revised, or whether
   the tokenizer accuracy caveat is acceptable as a labeled v1
   limitation.

## Requirement-to-Asset Map

For each requirement, what exists today and what gaps remain.

### Requirement 1: CLI distribution and host availability

| Asset | Status | Notes |
| --- | --- | --- |
| Nix overlay + HM module install pattern for a Node CLI on both nix-darwin hosts | **Exists** | `scripts/cavemem-import-vault.{nix,js}` + `overlays/cavemem-importer-deps/` + `home-manager/common/cavemem.nix:225-244` is the closest precedent. `home-manager/common/memory-sync.nix` + `home-manager/common/cc-sdd.nix` provide alternative module-shape examples. |
| HM-eval-time assertions that fail when a peer module is disabled | **Exists** | `home-manager/common/memory-sync.nix:34-46` uses `assertions = [{ assertion = config.programs.opencode.enable; message = ''…''; }]`. Diagnostic should mirror exactly. |
| Common install path enabled by default on both hosts vs per-host opt-in | **Constraint** | Two precedents exist. memory-sync (always-on via `home-manager/common/default.nix:161-178`) vs cavemem (per-host opt-in via `configurations/*/home-manager/default.nix`). Design picks one. Recommend always-on (mirrors memory-sync since the diagnostic is standard opencode tooling). |
| Stable PATH entrypoint | **Pattern** | `writeShellApplication`'s `name` arg sets the binary name. Recommend `opencode-cost-report`. |

### Requirement 2: Cost-attribution report content

| Asset | Status | Notes |
| --- | --- | --- |
| Session-level aggregate tokens (input/output/cache.read/cache.write/reasoning) and cost | **Exists in opencode DB** | `session` table columns `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`, `cost` (REAL). All denormalized from `step-finish` parts via opencode's own projector. |
| Per-step granular usage (one row per inner LLM call inside a tool loop) | **Exists in opencode DB** | `part.type = "step-finish"` rows in `message.data` JSON. Carries `cost`, `tokens.{input,output,reasoning,cache.{read,write}}` per inner call. |
| **Bucket (a) cached prefix served** | **Recoverable** | = `tokens_cache_read` per session (or summed across `step-finish` parts). No tokenizer needed. |
| **Bucket (b) cached prefix newly written** | **Recoverable but coarse** | = `tokens_cache_write` per session. opencode flattens Anthropic's 5m-vs-1h split into a single integer (verified in opencode `session.ts:380-444`). Diagnostic cannot distinguish 5m vs 1h ephemeral caches; this is an upstream limitation, not a diagnostic gap. |
| **Bucket (c) uncached input — total** | **Recoverable** | = `tokens_input` per session. **Important: opencode subtracts `cache_read + cache_creation` from the AI-SDK's `inputTokens`** so the stored value is already uncached-only. Anyone expecting `tokens_input` to mean "all prompt tokens" will misread. |
| **Buckets (c) system prompt / (d) conversation history / (e) tool outputs split within uncached input** | **Missing — requires re-tokenization** | The split is not in any column or any part-row metadata. Reconstructing requires walking `part` rows in time order per session and re-tokenizing each chunk into the appropriate bucket. Tokenizer accuracy is the bottleneck (see Tokenizer section below). |
| **Subagent dispatch totals** | **Recoverable** | `session.parent_id` (text, indexed) links subagent to dispatching session. Recursive CTE walks the tree. Subagent's tokens are disjoint from parent's (verified). Live example: dispatcher session `…28Vn` cost $17.31; five children sum to $20.41; total user-task cost $37.73. |
| Per-cwd grouping | **Recoverable** | `session.directory` (TEXT NOT NULL) is the canonical cwd. Group by `directory`. |
| Markdown report generator | **No precedent** | Repo has no Markdown templating; memory-sync uses plain `printf` for stdout. Diagnostic introduces. Either hand-rolled `printf` (simple), template literals (Node), or a tiny library. |
| JSON report generator | **Precedent** | memory-sync consumes JSON via `jq`; doesn't produce. `JSON.stringify` in Node is the obvious approach. |
| Empty-DB success exit | **No precedent** | Standard Node defensive code; trivial. |
| Cached-not-enabled finding | **No precedent** | Generated from the report data itself (sum of cache_read across sessions == 0). |

### Requirement 3: Selection and filtering

| Asset | Status | Notes |
| --- | --- | --- |
| Time-range filter | **No precedent** | Standard CLI flag (`--last 30d`, `--since`, `--until`). Parsing recommendation: a small parser using a precedent like `parse_since` (`memory-sync.nix:268-310`) or a Node lib (`ms`, `date-fns`). |
| Session-ID filter | **Trivial** | `WHERE id = ?` in SQL. |
| Project (cwd) filter | **Trivial** | `WHERE directory LIKE ?` or `= ?`. |
| AND combination | **Trivial** | Compose the WHERE clauses. |
| Actionable stderr on bad arg | **Precedent** | memory-sync's usage block at `:760-790` shows the convention. |

### Requirement 4: Privacy and content disclosure

| Asset | Status | Notes |
| --- | --- | --- |
| Default-exclude message bodies / tool outputs | **No precedent** | Repo has no analog; design introduces. Concrete shape: exclude `message.data.parts[*].text`, `message.data.parts[*].state.output`, and all `tool` part `state.input`/`state.output` from default output. |
| `--include-content` opt-in | **No precedent** | Standard CLI flag; trivial. |
| Mode 0600 on report files | **Precedent** | `umask 0077` before opening (`memory-sync.nix:340`). Same idiom. |
| XDG state dir output location | **Precedent** | `${XDG_STATE_HOME:-$HOME/.local/state}/<name>/` (`memory-sync.nix:30-43`, `sqlite-backup-cli.nix:97`). |
| Default report path under state dir | **Pattern** | `${STATE_DIR}/reports/<iso8601>.{md,json}` follows memory-sync's `${STATE_DIR}/logs/<iso8601>.log` shape. |

### Requirement 5: Schema-drift detection and graceful degradation

| Asset | Status | Notes |
| --- | --- | --- |
| Version-range pin readable from the diagnostic itself | **Precedent** | `cavemem.nix:178-208` pins a Zod enum value-set with explicit comment naming the upstream source. Diagnostic adapts: hardcode `OPENCODE_VERSION_RANGE = ">=0.X.Y <0.Z.0"` plus a schema fingerprint (SHA of `session.sql` from upstream) in the JS source. |
| Loud-failure on out-of-range schema | **Precedent** | `cavemem.nix:178-186` (Nix-eval enum), `cavemem-smoke-test.nix:282-318` (runtime hard-fail with named labels). Diagnostic checks the opencode version at startup; if outside range, exit non-zero with the stored range + detected version + recommended next action. |
| Smoke-test post-`nix flake update` | **Precedent** | `scripts/cavemem-smoke-test.nix` shipped on PATH. Diagnostic ships an analogous `scripts/opencode-cost-diagnosis-smoke-test.nix`. |
| Graceful "missing parent-child link" handling | **Easy** | If `session.parent_id` were ever removed/renamed (it isn't today), conservative attribution: attribute subagent tokens to the dispatching turn's `tool-call` part by time-correlation. Warn in the report. |
| Graceful "newer field missing on older opencode" | **Pattern** | Defensive defaults: `tokens.total` (newer field) computed locally if absent. Surface as finding only when material. |

### Requirement 6: Read-only safety and idempotence

| Asset | Status | Notes |
| --- | --- | --- |
| Read-only SQLite open | **Trivial** | `new Database(path, { readonly: true, fileMustExist: true })` in better-sqlite3. |
| Concurrent-safe with active opencode session | **Architectural property** | SQLite WAL mode supports N readers + 1 writer. better-sqlite3 honors this. Caveats: read snapshot is point-in-time; `-shm`/`-wal` sidecars must be in the same dir; macOS file lock is byte-range (harmless). Read-only open does NOT trigger WAL checkpoint. |
| Byte-identical JSON for identical input | **Easy** | Deterministic key order, no wall-clock in JSON, stable bucket-name ordering. |
| Missing-DB exit | **Trivial** | `fileMustExist: true` + try/catch. |
| I/O error exit with named path | **Pattern** | Standard try/catch + actionable message; mirrors memory-sync's per-failure stderr trailers (`memory-sync.nix:735-762`). |

### Requirement 7: Optional live-logger plugin

| Asset | Status | Notes |
| --- | --- | --- |
| opencode plugin install via `xdg.configFile."opencode/plugins/<name>.{js,ts}".source` | **Precedent** | Two existing plugins: `home-manager/common/opencode-plugins/cavemem.js` (mounted via `cavemem.nix:380`) and `opencode-plugins/zellij-attention.ts` (mounted via `home-manager/common/default.nix:199-200`). Plugin source byte-identical to checked-in file; opencode auto-discovers; no settings.json registration; no build step (.ts transpiles at runtime). |
| Plugin lifecycle hooks (`message.updated`, `tool.execute.before/after`, `session.idle`) | **Confirmed available** | Verified in opencode plugin docs and existing plugin files. |
| Plugin writes to XDG state dir | **Trivial** | Plugin imports `node:fs` + `node:path`; computes `${XDG_STATE_HOME ?? `${homedir()}/.local/state`}/opencode-cost-diagnosis/events.jsonl`. |
| Plugin honors same privacy posture as CLI | **Design discipline** | Default-exclude content; same opt-in flag passed via env var or opencode config. |
| Design doc records binary decision (include in v1 OR defer with trigger) | **Process requirement** | Mechanically verifiable by inspecting `.kiro/specs/opencode-cost-diagnosis/design.md` after design phase. |

## Implementation Approach Options

### Option A: Extend Existing Components

**When to consider**: Feature fits naturally into existing structure.

Examined extension candidates:

| Existing component | Could we extend it? | Recommendation |
| --- | --- | --- |
| `cavemem-import-vault` | Different semantics (one-shot vault → cavemem import); doesn't reduce scope here | No |
| `cavemem-importer-deps` | Could add tokenizer dep to share deps tree | **Discouraged** — violates SRP; different lifecycle (importer is one-shot, diagnostic is daily); blast radius if either bumps a shared dep |
| `memory-sync` | Pure orchestration script; reading opencode DB is not its concern | No |
| `cc-sdd` HM module | Skill installer, unrelated | No |

**Verdict on A**: Pure-extension does not fit. Nothing meaningfully reusable beyond patterns.

**Trade-offs**: N/A.

### Option B: Create New Components (RECOMMENDED)

**Rationale**: The diagnostic is a distinct responsibility (read opencode session DB, attribute cost) with a distinct lifecycle (always-on tool, re-run after every cost-reduction spec). It shares no runtime data with existing tools. Clean separation of concerns; mirrors the cavemem-import-vault structural shape exactly.

**New files (5-7 depending on plugin decision)**:

| File | Role |
| --- | --- |
| `overlays/opencode-cost-diagnosis-deps/{package.json, package-lock.json}` | Vendored npm dep tree (`better-sqlite3@12.10.0`, optionally `@anthropic-ai/tokenizer`). Mirrors `overlays/cavemem-importer-deps/` exactly. |
| `overlays/mcp-servers.nix` (or new `overlays/opencode-cost-diagnosis.nix`) | `buildNpmPackage` + `importNpmLock` derivation producing `pkgs.opencode-cost-diagnosis-deps`. Mirrors `cavemem-importer-deps` block at `mcp-servers.nix:328-378`. |
| `scripts/opencode-cost-report.nix` | `writeShellApplication` wrapper: exports `NODE_PATH=${opencode-cost-diagnosis-deps}/lib/node_modules`, optionally `OPENCODE_DATA_DIR=${config.xdg.dataHome}/opencode`, then `exec ${nodejs}/bin/node ${./opencode-cost-report.js} "$@"`. ~15 lines of Bash. |
| `scripts/opencode-cost-report.js` | Node logic. SQLite reader (read-only), CLI flag parser, attribution logic, report generators (MD + JSON), schema-drift check. ~300-600 lines depending on bucket-attribution strategy. |
| `home-manager/common/opencode-cost-diagnosis.nix` | HM module exposing `programs.opencode-cost-diagnosis.{enable, package}`. Asserts `programs.opencode.enable`. Adds derivation to `home.packages`. ~50-80 lines. |
| `home-manager/common/default.nix` (modify) | Add import + `programs.opencode-cost-diagnosis.enable = true;` (always-on). |
| `scripts/opencode-cost-diagnosis-smoke-test.nix` | Post-`nix flake update` verification: opens the live opencode DB, checks the schema fingerprint, exits with named labels on drift. Mirrors `cavemem-smoke-test.nix`. ~50 lines. |
| `home-manager/common/opencode-plugins/opencode-cost-logger.ts` (IF plugin in v1) | Plugin source. Subscribes to `message.updated`, writes one JSONL line per assistant turn to `$XDG_STATE_HOME/opencode-cost-diagnosis/events.jsonl`. ~40-80 lines. |

**Integration points**:

- HM-eval assertion against `programs.opencode.enable` (peer-module requirement)
- `xdg.dataHome` for the source DB path
- `xdg.stateHome` (via Bash) for the output dir
- Existing pre-commit hooks (nixfmt, deadnix, statix, no-hardcoded-users, no-tmp-paths) apply to all new `.nix` files

**Trade-offs**:

- ✅ Clean separation; each file has a single responsibility
- ✅ Mirrors cavemem-import-vault structurally → low novelty, fast review
- ✅ Easy to test each layer in isolation (Node script can be unit-tested against a fixture DB)
- ✅ The optional plugin is a clean add (or omit) — no entanglement with the CLI's core
- ❌ More files to navigate (5-7 vs hypothetical 2-3 for a hybrid)
- ❌ Introduces a new vendored deps tree (operationally identical to cavemem-importer-deps so the precedent is well-trodden)

### Option C: Hybrid Approach

**When to consider**: Complex features requiring both extension and new creation.

A genuinely hybrid path would be: share `cavemem-importer-deps` (add tokenizer to it) AND create new everything else. This is the only non-trivial hybrid considered.

**Trade-offs**:

- ✅ One vendored deps tree to maintain
- ❌ Couples the diagnostic's lifecycle to the cavemem importer's lifecycle (a forced better-sqlite3 bump for one becomes a forced bump for the other; a security patch on tokenizer churns the cavemem importer)
- ❌ Misleading module name (`cavemem-importer-deps` now ships diagnostic deps)
- ❌ Blast radius: if the diagnostic introduces a tokenizer with breaking changes, cavemem-import-vault's CI / smoke test could pick up regressions unrelated to it

**Verdict on C**: Not recommended. Coupling cost > consolidation benefit.

## The Bucket-Attribution Decision (the most consequential design question)

R2.AC3 currently specifies five buckets:

> (a) system-prompt cached prefix tokens, (b) system-prompt uncached
> prefix tokens, (c) conversation-history tokens, (d) tool-output
> tokens, (e) subagent-dispatch tokens.

Schema reality:

- (a) and (b) are recoverable from `tokens_cache_read` and
  `tokens_cache_write`. **No tokenizer needed.** **However**: opencode
  conflates "system-prompt cached" with "any other cached prefix" —
  the cache_read counter is total cached input, not just system
  prompt. If a long conversation-history segment was cached on a prior
  turn, it shows up in cache_read too. To split (a) from "history that
  happens to be cached" requires part-row walking.
- (e) is recoverable from `session.parent_id` recursive CTE. **No
  tokenizer needed.**
- (c) and (d) within the uncached input (`tokens_input`) ARE NOT
  recoverable without re-tokenization. The split requires walking each
  message's `part` rows in time order and re-tokenizing each chunk.

Three ambition levels, with explicit tradeoffs:

### Level 1 (Aggregates-only, S, Low risk)

Report uses only opencode's denormalized session aggregates plus the
recursive subagent rollup. Bucket-list becomes:

- cached_read (any cached input — system or history)
- cached_write (newly cached this turn)
- uncached_input (system + history + tool outputs — undifferentiated)
- output
- reasoning
- subagent_dispatch (recursive sum)

**Pros**: No tokenizer. Effectively free compute. Numbers are
verbatim from opencode's stored values; no accuracy caveat. Fast (a
30-day report on a 1 GB DB completes in <1s).

**Cons**: Does NOT satisfy R2.AC3 as currently written. The 5-bucket
promise becomes a 4-bucket reality + a partial cache-split. **Requires
revising R2.AC3** to reflect this scope, OR explicitly labeling v1
as "aggregate-only" with the bucket split scoped to v2.

### Level 2 (Aggregates + tokenizer re-attribution, M, Medium risk)

Aggregates as above, PLUS reconstruct each prompt from `part` rows,
re-tokenize each chunk, and split `tokens_input` into (c) and (d)
proportionally. Cache buckets stay coarse (no split between cached
system-prompt vs cached history) unless we also re-tokenize the
cached portion (compute cost doubles).

**Pros**: Satisfies R2.AC3 as written (with one labeling caveat).
Bucket split is meaningful for the cost-driver investigation.

**Cons**:

- Tokenizer is the bottleneck. `@anthropic-ai/tokenizer` is
  Claude-2-era BPE; under-counts Claude 4 by ~15%. Re-tokenization
  results MUST be labeled "approximate, Claude-2 BPE proxy ±15% on
  Claude 4."
- Performance: ~1-5 MB/s of UTF-8 in Node single-threaded; a 1 GB
  tool-output corpus → 200-1000s. Gate behind a `--retokenize` flag
  (off by default), or accept slow runs.
- Adds tokenizer dep; ~2-5 MB to the vendored deps tree.

### Level 3 (Aggregates + tokenizer + API cross-check, L, Medium-High risk)

Above plus: for a sample of N sessions, call Anthropic's
`messages.count_tokens` API and compare against the local tokenizer
estimate. Surface drift in the report (e.g. "tokenizer estimate is
12.4% under true count on sampled subset").

**Pros**: Highest fidelity. Diagnostic itself measures its own
tokenizer accuracy, eliminating the abstract "±15%" caveat.

**Cons**:

- Adds network dependency to the diagnostic (was previously
  fully-local).
- API rate limits constrain sample size; design phase needs to pick a
  budget.
- Requires `ANTHROPIC_API_KEY` to be present in the diagnostic's
  environment (the user already has one for opencode, so this is
  just plumbing).

### Recommended path for design phase

**Level 2** with the tokenizer accuracy caveat printed in the report.
Reasoning:

- Level 1 makes the diagnostic less useful than its own requirements
  promise; rewriting R2.AC3 to back down from the 5-bucket split
  undermines the "evidence-rank follow-on interventions" mission.
- Level 2 satisfies R2.AC3 with an honest accuracy disclaimer. The
  disclaimer is information, not failure.
- Level 3 is over-engineering for v1. Add it as a deferred feature
  if Level 2's accuracy proves too noisy in practice.

Design phase should flag this decision explicitly and either confirm
Level 2 or come back to requirements to revise R2.AC3 (Level 1).

## Effort and Risk

| Component | Effort | Risk | Justification |
| --- | --- | --- | --- |
| Vendored deps tree + Nix derivation | S | Low | Direct copy of `cavemem-importer-deps` pattern; build flags already proven on Darwin |
| HM module + always-on wiring | S | Low | Direct mirror of `memory-sync` shape |
| CLI flag parser, SQLite reader, filter logic | S | Low | Standard Node CLI scaffolding |
| Aggregates-only attribution (Level 1) | S | Low | Sum stored columns + recursive CTE for subagents |
| Re-tokenization attribution (Level 2) | M | Medium | Tokenizer accuracy caveat is the dominant risk; design must commit to and document the disclaimer |
| API cross-check (Level 3) | M | Medium | Adds network and rate-limit logic; defer |
| Markdown + JSON report generator | S | Low | No precedent; trivial to introduce |
| Privacy default-exclude + opt-in | S | Low | Straightforward flag-gated content emission |
| Schema-drift pin + smoke test | S | Low | Direct mirror of `cavemem-smoke-test.nix` pattern |
| Optional live-logger plugin | S | Low | Direct mirror of `opencode-plugins/cavemem.js` and `zellij-attention.ts` install pattern |

**Total v1 estimate by ambition level**:

- Level 1 (aggregates-only): **S, 2-3 days**. Low risk.
- Level 2 (re-tokenization): **M, 5-7 days**. Medium risk (tokenizer
  accuracy caveat).
- Level 3 (re-tokenization + API cross-check): **L, 8-12 days**.
  Medium-High risk.
- Plugin in v1: **+S, 1-2 days**.
- Smoke test: **+S, 0.5-1 day**.

## Research Needed in Design Phase

These items require a decision (or a deferral) in `design.md`:

1. **Bucket-attribution strategy**: pick Level 1 / Level 2 / Level 3.
   If Level 1, revise R2.AC3 to scope down the bucket list. If
   Level 2 or 3, commit to and document the tokenizer accuracy
   caveat. **This is the most consequential design decision.**

2. **Tokenizer choice** (if Level 2 or 3): `@anthropic-ai/tokenizer`
   0.0.4 (Apache-2.0, Claude-2 BPE, ~15% under on Claude 4); OR
   `tiktoken` (MIT, cl100k_base, ~10-30% over on Claude); OR
   Anthropic's `messages.count_tokens` API (authoritative but
   per-request and rate-limited). Recommend
   `@anthropic-ai/tokenizer` for Level 2 since it's the closest
   approximation to Claude's tokenization, with the explicit
   disclaimer in the report.

3. **Live-logger plugin in v1?** Binary decision per R7.AC5. If
   deferred, name the trigger condition. Concrete trigger candidate:
   "if the diagnostic's snapshot-only view obscures hot-spot turns
   within a single session (e.g. one turn consuming 70% of session
   cost), enable the plugin to expose per-turn deltas continuously."

4. **Schema-drift pinning approach**:
   - Pin the supported opencode version range as a string
     (e.g. `">=0.X.Y <0.Z.0"`)?
   - Pin a SHA of the `session.sql` schema as a fingerprint?
   - Both? The cavemem precedent pins values verbatim from the Zod
     schema, with a runtime smoke test verifying the contract holds.
     Recommend: pin a schema fingerprint (SHA of relevant subset of
     columns) plus a supported version range; fail loudly if either
     drifts.

5. **Module enablement**: always-on (mirrors memory-sync) or
   per-host opt-in (mirrors cavemem)? Recommend always-on. The
   diagnostic is standard opencode tooling and should be present
   wherever opencode is.

6. **Output path policy**:
   - Stdout for human-readable summary vs explicit file output?
   - If file output, fixed path or `--output <path>`?
   - Default retention policy for reports (mirror memory-sync's
     last-10 prune)?
   Recommendation: stdout for the summary block; per-run files at
   `$XDG_STATE_HOME/opencode-cost-diagnosis/reports/<iso8601>.{md,json}`
   with last-10 prune.

7. **Cost source**: trust opencode's stored `cost` field (locally
   computed against models.dev pricing) vs recompute from
   tokens + a vendored pricing snapshot? Recommendation: trust
   opencode's value; it's authoritative within the running opencode
   process. Recompute is a Level 3+ feature.

8. **Reasoning tokens**: opencode currently bills `tokens_reasoning`
   at the output rate (per a TODO comment in opencode source).
   Should the diagnostic call this out as its own bucket, or fold
   it into output? Recommendation: emit as its own line in the
   report for visibility (operator-observable curiosity), label as
   "billed-at-output-rate per opencode source."

9. **5m vs 1h cache-write split**: opencode flattens this; the
   diagnostic cannot recover the split. Document the limitation in
   the report's caveat section. No design decision needed.

10. **Better-sqlite3 vs node:sqlite**: Node 22.5+ has built-in
    `node:sqlite`, no native build. Cleaner Nix story. Trade-off:
    the cavemem deps tree already uses better-sqlite3 successfully;
    switching adds inconsistency. Recommend stay on better-sqlite3
    for consistency.

## Recommendations Summary

- **Approach**: Option B (Create new components). Mirror
  `cavemem-import-vault` structurally.
- **Bucket-attribution**: Default to Level 2 (re-tokenization) with
  honest tokenizer-accuracy disclaimer. Surface to user if they want
  Level 1 (revise R2.AC3) or Level 3 (defer to v2).
- **Plugin v1?**: Recommend deferral with the trigger "per-turn
  hot-spot visibility needed within a single session." Reasoning: v1
  produces a usable cost-attribution baseline without the plugin; the
  plugin is additive enrichment that can ship after v1 lands.
- **Enablement**: Always-on via `home-manager/common/default.nix`.
- **SQLite driver**: `better-sqlite3@12.10.0` (consistency with
  cavemem precedent).
- **Schema-drift detection**: Pinned version range + schema
  fingerprint + smoke-test verifier on PATH.
- **Effort estimate**: Level 2 + smoke test = M (5-8 days).
- **Risk register**: Tokenizer accuracy (Medium); schema drift
  (Medium, mitigated by pinning + smoke test); subagent recursive CTE
  edge cases (Low with careful implementation).

---

## User Decisions Recorded (Pre-Design)

The following decisions were made by the operator in direct response
to this gap analysis on 2026-05-16, before `/kiro-spec-design` runs.
They are recorded here so the design phase has them as durable input.
All other open questions (plugin v1 vs deferred, always-on vs opt-in,
schema-drift pinning approach, better-sqlite3 vs node:sqlite, cost
source, reasoning-tokens bucket, output path policy) remain open and
are deferred to design phase.

### Decision 1: Bucket-attribution at Level 2

**Decision**: Re-tokenize `part` rows to preserve the 5-bucket
attribution specified in R2.AC3. Do NOT scope down to Level 1
(aggregates-only) and do NOT pursue Level 3 (API cross-check) in v1.

**Rationale (operator stated)**: "Exactly accurate token counts are
not critical so long as the counts are correct relative to each
other." The diagnostic's mission is to RANK cost drivers so follow-on
specs target the right layer; absolute token-count accuracy is
secondary to relative bucket proportions.

**Consequence**: R2.AC3 stands as written. The 5 buckets are
produced. The tokenizer is used only for the *relative* split within
uncached input.

### Decision 2: Tokenizer is `tiktoken` (cl100k_base), with explicit warnings

**Decision**: Use `tiktoken` (the JS-WASM port of OpenAI's tokenizer,
cl100k_base encoding). Do NOT use `@anthropic-ai/tokenizer` despite
it being Claude-branded.

**Rationale (operator stated + research-supported)**: tiktoken is
actively maintained (vs @anthropic-ai/tokenizer's 2023 freeze),
MIT-licensed, and produces stable token counts that are ~10-30%
larger than Claude's actual count. @anthropic-ai/tokenizer ships
Claude-2-era BPE and under-counts Claude 4 by ~15%. Neither is
accurate in absolute terms; tiktoken's over-count is more
mechanically consistent across content types, which preserves
relative-correctness better than @anthropic-ai/tokenizer's
under-count (which appears to vary more by content shape per the
upstream issue tracker).

**Consequence**: Design phase must:
- Source `tiktoken` (npm package by dqbd, not OpenAI directly) into
  the vendored deps tree at `overlays/opencode-cost-diagnosis-deps/`
- Resolve the cl100k_base encoding at startup (loads a small JSON
  vocab file shipped inside the npm package; no network at runtime)
- WASM build is simpler than `better-sqlite3`'s native build — no
  cctools, no `build_from_source`, just include the .wasm asset
- The diagnostic still vends `better-sqlite3` for the SQLite read,
  so the deps tree carries both

### Decision 3: Bucket-attribution math must preserve sum-correctness

**Decision** (derived from Decisions 1 and 2): The 5 buckets must
SUM to opencode's authoritative session totals. The tokenizer's
relative-accuracy-only property means tiktoken counts cannot be
emitted as absolute bucket totals; they must be used as
PROPORTIONS applied to opencode's stored authoritative aggregates.

**Concrete pattern for design phase**:

For each session, let `T_input_stored = tokens_input` (opencode's
authoritative value, populated from the API response). For each
`part` in the prompt construction, compute `p_i = tiktoken_count
(part_i.content)`. Compute the per-category sums `P_sys`, `P_hist`,
`P_tool` (where each part is classified to one category by
provenance).

Then:
- `bucket_uncached_system_prompt = T_input_stored * P_sys / (P_sys
  + P_hist + P_tool)`
- `bucket_conversation_history = T_input_stored * P_hist / (P_sys
  + P_hist + P_tool)`
- `bucket_tool_outputs = T_input_stored * P_tool / (P_sys + P_hist
  + P_tool)`

This guarantees:
1. Bucket totals SUM to `T_input_stored` (sum-correct against
   opencode's authoritative value).
2. Bucket PROPORTIONS reflect actual content sizes per tiktoken
   (relative-correct within the operator's stated tolerance).
3. Absolute bucket counts inherit tiktoken's per-content-type bias
   (acceptable per Decision 1).

Cache-bucket totals (`bucket_cached_read`, `bucket_cached_write`)
come directly from `tokens_cache_read` / `tokens_cache_write` —
authoritative, no tokenizer involved. Subagent bucket totals come
from the recursive `parent_id` CTE summing child-session aggregates
— authoritative, no tokenizer involved.

The tokenizer's relative-accuracy caveat applies ONLY to the
three-way split within uncached input.

### Decision 4: Disclaimer placement in every report

**Decision**: Every Markdown and JSON report MUST surface the
tokenizer disclaimer prominently — not buried in a footnote.

**Recommended disclaimer text for design phase to refine**:

> NOTE: The split of uncached input into (system prompt) /
> (conversation history) / (tool outputs) is estimated using
> tiktoken (cl100k_base), which over-counts Claude tokens by an
> estimated 10-30% across content types. Bucket SUMS are
> authoritative (they sum exactly to opencode's stored
> `tokens_input`, which came from the Anthropic API response).
> Bucket PROPORTIONS within the uncached-input total are relative
> estimates suitable for ranking cost drivers, not for billing
> reconciliation. Cached input buckets (`cached_read`,
> `cached_write`) and subagent rollup buckets are
> authoritative, not estimated.

JSON output should include a structured `tokenizer_disclaimer` field
with `library`, `encoding`, `accuracy_class` (e.g. `"relative-only"`),
and `affected_buckets` (the three uncached-input splits) so machine
consumers can detect the caveat programmatically.

### Open questions still deferred to design phase

These were NOT decided by the operator and remain open for
`/kiro-spec-design`:

1. Live-logger plugin in v1 vs deferred (R7.AC5 binary decision)
2. Always-on enablement (mirroring memory-sync) vs per-host opt-in
   (mirroring cavemem)
3. Schema-drift pinning approach (version string only / schema
   fingerprint only / both)
4. better-sqlite3 vs node:sqlite (gap analysis recommended
   better-sqlite3 for consistency; not user-confirmed)
5. Cost-source policy (trust opencode's stored `cost` field vs
   recompute from models.dev pricing)
6. Reasoning tokens as their own report bucket vs folded into
   output bucket
7. Output path / retention policy (stdout summary + per-run files
   with last-10 prune is gap-analysis recommendation, not
   user-confirmed)

---

## Design Decisions (closed by /kiro-spec-design on 2026-05-16)

The seven open questions above were resolved in `design.md`. Recording
the outcomes here for traceability.

### Decision: Live-logger plugin DEFERRED in v1

- **Context**: R7.AC5 demands a binary in-v1-or-deferred decision.
- **Alternatives Considered**:
  1. Ship in v1 — adds intra-session hot-spot visibility
  2. Defer with named trigger — keeps v1 scope tight
- **Selected Approach**: Defer. Trigger condition documented:
  "If a snapshot report identifies a session where a single turn
  consumes more than 50% of that session's total cost AND the
  operator wants continuous intra-session hot-spot visibility
  without rerunning the diagnostic, open a follow-on spec."
- **Rationale**: v1 produces a usable baseline without the plugin;
  R7.AC1 (works without plugin) is already in scope. Shipping the
  plugin in v1 doubles the test surface and delays the baseline.
- **Trade-offs**: Operator must rerun the diagnostic manually if
  they want updated numbers; acceptable for a primitive that's
  re-run after each cost-reduction intervention regardless.
- **Follow-up**: When the trigger condition fires, open a new
  spec; reuse the cavemem.js / zellij-attention.ts install
  precedent.

### Decision: Always-on enablement via common HM

- **Context**: Memory-sync precedent (always-on) vs cavemem
  precedent (per-host opt-in).
- **Selected Approach**: Always-on via
  `home-manager/common/default.nix` (memory-sync precedent).
- **Rationale**: The diagnostic is standard opencode tooling on
  this nix-config, not a host-specific addition. Both hosts run
  opencode, so both should have the diagnostic available.
  HM-eval-time assertion against `programs.opencode.enable`
  prevents enablement on hosts without opencode.

### Decision: Schema-drift via supported version range + migration set

- **Context**: How to detect when opencode's DB shape has shifted
  in a way that would silently miscount.
- **Alternatives Considered**:
  1. Version string only — pin a semver range
  2. Schema fingerprint only — SHA the relevant `sqlite_schema`
     subset
  3. Both — version range checked first, migration-set
     compared on success
- **Selected Approach**: Read the `data_migration` table and
  compare against a pinned migration set (declared as a const in
  the SQLite Reader module). Surface the supported version range
  via `--supported-opencode-version`. Fallback to schema-text
  hashing of the four columns the diagnostic actually reads if
  `data_migration` is absent.
- **Rationale**: Migration-set comparison is more precise than
  version strings (opencode could land a non-schema-affecting
  patch release without bumping the diagnostic's pin). Less
  brittle than schema-text hashing (which would fail on cosmetic
  schema text changes).

### Decision: SQLite driver is better-sqlite3@12.10.0

- **Context**: better-sqlite3 (mature, requires native build) vs
  node:sqlite (Node 22.5+, zero native deps).
- **Selected Approach**: better-sqlite3@12.10.0.
- **Rationale**: Consistency with `cavemem-importer-deps`, which
  already vends this exact version and has solved the Darwin
  native-build pattern (`npm_config_build_from_source=true`).
  node:sqlite would diverge the Node-tooling story for marginal
  simplification.

### Decision: Trust opencode's stored `cost` field

- **Context**: Recompute from models.dev pricing vs trust opencode's
  per-turn `cost` value.
- **Selected Approach**: Trust opencode's stored `cost`. Sum across
  sessions and report.
- **Rationale**: opencode's value is authoritative within the
  running opencode process (computed at the time of the API
  response, using the price table opencode loaded). Recomputing
  from models.dev would diverge from what the operator actually
  saw billed during the session. Recompute is a Level 3+ feature
  if billing reconciliation ever becomes a need.

### Decision: Reasoning tokens get their own bucket

- **Context**: opencode bills `tokens_reasoning` at the output rate
  per a TODO in opencode source. Should the diagnostic surface
  this as its own bucket?
- **Selected Approach**: Yes — emit `reasoning` as its own field in
  `BucketTotals`. Per-turn cost folds into the report alongside.
- **Rationale**: Reasoning is operator-observable signal
  (extended-thinking is a known cost lever). Folding into output
  would hide the magnitude. Cost is still attributed to the
  output bucket per opencode's accounting; the token-count bucket
  is its own line for visibility.

### Decision: Output path is XDG state dir with last-10 prune

- **Context**: Where reports go and how long they're retained.
- **Selected Approach**: Default to
  `${XDG_STATE_HOME:-$HOME/.local/state}/opencode-cost-diagnosis/reports/<iso8601>.{md,json}`
  with mode `0600` (umask `0o077`) and last-10 retention per
  format. `--output <path>` overrides for one-off writes (no
  pruning when overridden).
- **Rationale**: Mirrors `memory-sync` exactly. Operator-observable
  default location; private-by-default; bounded growth.

## Synthesis Outcomes

Recorded here per design-synthesis.md guidance.

### Generalization

None identified. The seven requirements address one cohesive feature
(a single CLI); no requirement is a special case of a more general
capability that would benefit from a generalized interface.

### Build vs. Adopt

| Component | Decision | Rationale |
| --- | --- | --- |
| SQLite read | ADOPT (better-sqlite3) | Repo precedent; mature; WAL-safe |
| Tokenizer | ADOPT (tiktoken WASM) | Operator-confirmed; WASM avoids native build complexity |
| CLI argument parsing | BUILD (hand-rolled) | Small flag surface; dep would be over-engineering |
| Time-range parsing | BUILD (hand-rolled) | Single function; mirrors memory-sync's bash precedent |
| Markdown generation | BUILD (template literals) | Fixed structure; templating dep would be over-engineering |
| JSON generation | ADOPT (JSON.stringify stdlib) | Built into Node; custom replacer for stable key order |
| Install pattern | ADOPT (writeShellApplication + HM module) | Mirrors cavemem-import-vault and memory-sync precedents |
| Schema-drift detection | BUILD (custom) | No library does this for opencode specifically |

### Simplification

- **Single-file Node CLI** (~500-700 LOC) instead of per-component
  files: components have strict left-to-right dependency direction,
  no circular imports possible, single file keeps grep and review
  simple. Split per-layer only if file exceeds 1000 LOC.
- **No commander/yargs** for argument parsing: removes a transitive
  dep tree for what amounts to ~50 LOC of hand-rolled flag handling.
- **No templating library** for Markdown: template literals are
  sufficient for the fixed report shape.
- **No comparison-reports / forecasting / anomaly-detection** in v1:
  out of scope per requirements; would add abstraction layers that
  serve hypothetical future needs.
- **Live-logger plugin deferred**: avoids doubling the test surface
  in v1.

---

## Design Iteration 2 (2026-05-16, post-validation)

`/kiro-validate-design` surfaced three issues against the first design
draft. Two were Critical; one was Moderate. Operator confirmed fix
direction; targeted edits applied to `design.md` rather than full
regenerate to preserve composition. Outcomes:

### Fix 1: Tokenizer Splitter interface + classification rules (Critical)

- **Issue**: Tokenizer Splitter needed `MessageRow` for role-based
  classification, but the SQLite Reader interface did not expose any
  `messagesOfSession()` method or `MessageRow` type. Separately, the
  classification rules did not cover `part.type == "text" AND
  message.role == "assistant"`, which would have systematically
  under-counted `history` for every multi-turn session.
- **Fix applied**:
  - Added `messagesOfSession(sessionId): Iterable<MessageRow>` to
    `SqliteReader` with `role` parsed out of `message.data` JSON
    so callers do not re-parse.
  - Added `MessageRow` type definition to the Reader interface
    block; removed the duplicate stub from the Tokenizer interface.
  - Replaced the temporally-coupled "not preceded by a `tool` part
    in the same turn" rule with the session-aggregate-friendly
    rule set: text+system → `system-prompt`; text+user → `history`;
    text+assistant → `history`; tool with output → `tool-output`;
    reasoning/step-start/step-finish/compaction/agent/patch/file →
    skip; any other `part.type` → `unclassified` with
    `schema_partial_data` finding.
- **Rationale**: The session-aggregate view does not need to
  distinguish "current turn's tool output" from "prior turn's tool
  output"; all tool output that ever flowed into any turn's prompt
  is the same conceptual bucket. Simpler rules; complete coverage.

### Fix 2: CostBuckets nullable per-bucket fields + total (Critical, split)

- **Issue**: `CostBuckets` declared per-bucket cost fields as
  `number`, but opencode stores only per-session `cost` (REAL); the
  design also placed pricing recompute Out of Boundary. The type
  was unfulfillable under its own constraints.
- **Operator decision**: Keep per-bucket cost in the type (don't
  drop it) but defer the recompute to a follow-on spec. v1 emits
  per-bucket fields as `null`.
- **Fix applied**:
  - Added `total: number` to `CostBuckets` (the only cost field v1
    populates, sourced from `session.cost`).
  - Changed all per-bucket cost fields to `number | null`.
  - Added `per_bucket_cost_deferred` finding kind to the `Finding`
    union; Attribution Engine emits exactly one such finding per
    session.
  - Added Revalidation Trigger: "Decision to implement per-bucket
    cost recompute → new spec defines pricing source and
    population algorithm; `per_bucket_cost_deferred` finding stops
    being emitted."
  - Updated Out of Boundary clause for per-model pricing recompute
    to call out the deferral explicitly.
- **Rationale (cost-representation choice)**: Operator chose
  "nullable fields, finding `per_bucket_cost_deferred`" over
  "optional fields, omit in v1" because nullable + finding is more
  explicit about the gap in the JSON contract; downstream consumers
  can detect the deferral programmatically instead of inferring from
  field absence. Forward-compatible: when the recompute spec lands,
  same JSON shape — fields just become populated.

### Fix 3: Schema-drift mechanism pinned to live baseline (Moderate)

- **Issue**: SQLite Reader's Implementation Notes left "verify exact
  mechanism at implementation time" with a `data_migration` table OR
  schema-text hash fallback, and no actual baseline pinned.
- **Verification before fix**: Ran live against
  `~/.local/share/opencode/opencode-stable.db` on the Shopify host:
  - `data_migration` table exists with schema
    `CREATE TABLE data_migration (name TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`.
  - Migration set as of 2026-05-16:
    `["session_usage_from_messages"]` (single row, `time_completed`
    timestamp ~2026-04-17).
- **Fix applied**: Committed to the `data_migration` table approach
  (no fallback path); pinned the v1 baseline migration set to
  `["session_usage_from_messages"]` directly in design.md's
  Implementation Notes. Loud failure on any drift (additional,
  removed, or renamed migration names).
- **Rationale**: The fallback path (schema-text hashing) added
  complexity for a low-probability event (opencode removing the
  `data_migration` table is unlikely); the diagnostic's failure on
  that event would be loud and actionable either way. Removing the
  fallback simplifies the code path and matches the cavemem-style
  "fail loudly on upstream change" precedent.

### Validation re-run plan

Iteration 2's edits are local to existing components (no architectural
change, no boundary change, no new components). Re-running
`/kiro-validate-design opencode-cost-diagnosis` should now pass all
three previously-flagged criteria.

---

## Design Iteration 2.5 (2026-05-16, post-second-validation)

Second `/kiro-validate-design` pass found one minor contract gap and
surfaced two non-blocking notes. Operator chose to apply all three
fixes inline (a) ProvenanceCounts gap (Critical), (b) aggregate cost
forward-compat (non-blocking but worth aligning now), (c) leaving the
LOC-estimate note as-is.

### Fix 1: ProvenanceCounts.unclassifiedCount

- **Issue**: Classification rule said "Any other part.type value →
  unclassified; emit schema_partial_data finding, do NOT silently
  include in any bucket", but ProvenanceCounts had no field to carry
  the unclassified token count back to Attribution Engine, so the
  finding could not be emitted when SOME (but not all) parts were
  classifiable.
- **Fix applied**: Added `unclassifiedCount: number` to
  ProvenanceCounts. Added Attribution Engine responsibility bullet:
  "If `provenanceCounts.unclassifiedCount > 0` for a session, emit
  one `schema_partial_data` finding per session naming the count
  and the set of unrecognized `part.type` values encountered; the
  proportional split for that session uses only the classified
  totals (unclassified tokens are NOT folded into any bucket)."
  Added unit test 8 covering this path.

### Fix 2: Aggregate cost forward-compat (non-blocking, aligned now)

- **Issue**: `DiagnosticReport.globalTotals.costTotal: number` and
  `ProjectAggregate.cost: number` were scalars. When the cost-recompute
  spec lands and SessionAttribution.cost per-bucket fields become
  populated, the aggregates would need to widen — requiring a
  `schemaVersion: 1 → 2` bump for downstream consumers.
- **Fix applied**:
  - Changed `globalTotals: BucketTotals & { costTotal: number }` to
    `globalTotals: { tokens: BucketTotals; cost: CostBuckets }`.
  - Changed `ProjectAggregate.cost: number` to
    `ProjectAggregate.cost: CostBuckets`.
  - In v1, both `cost` fields populate only `cost.total` (sum of
    `session.cost`); per-bucket fields are `null`. Same forward-compat
    pattern as `SessionAttribution.cost`. When the recompute spec
    lands, per-bucket aggregates appear here without a JSON schema
    bump.
  - Added unit test 9 covering aggregate cost.total population and
    null per-bucket field invariants.
- **Rationale**: Trade a tiny v1 JSON-output verbosity (`cost: { total: 5.23, cachedRead: null, ... }`)
  for zero schema-version bump risk in the future spec. The
  downstream cost-reduction specs consume this JSON to measure
  before/after impact — keeping schemaVersion stable across the
  diagnostic's evolution lets them keep their parsers fixed.

### Acceptable risk: LOC estimate optimistic (no change)

- **Issue**: Single-file Node CLI estimate of 500-700 LOC may be
  closer to 700-1000 LOC in practice with TypeScript-style
  annotations and 9 internal modules.
- **Decision**: Leave as-is. Design already self-handles via "split
  per logical layer if file exceeds 1000 LOC" rule in the
  Component-to-File Mapping section. If the file lands closer to
  900 LOC, the implementer can split early; if it lands at 700,
  single-file remains the right call.
