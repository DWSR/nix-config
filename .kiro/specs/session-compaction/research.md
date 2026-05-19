# Implementation Gap Analysis: session-compaction

_Generated: 2026-05-19. Inputs: requirements.md (R1–R9), brief.md,
discovery sub-agent surface map, viability check, opencode plugin and
SDK docs, existing in-repo plugins and HM modules._

## 1. Current State Investigation

### 1.1 Existing opencode plugins (the install pattern this spec must mirror)

Two plugins are committed in-tree, both installed via the same
`xdg.configFile` symlink pattern. There is no overlay-built plugin
derivation; the plugin files are JS/TS source, vendored verbatim.

| Plugin | File | Install site | Hooks used |
|---|---|---|---|
| cavemem | `home-manager/common/opencode-plugins/cavemem.js:1-82` | `home-manager/common/cavemem.nix:380` (`xdg.configFile."opencode/plugins/cavemem.js".source`) — gated by `home.cavemem.enable` | `session.created`, `session.idle`, `tool.execute.before`, `tool.execute.after` |
| zellij-attention | `home-manager/common/opencode-plugins/zellij-attention.ts:1-56` | `home-manager/common/default.nix:201-202` (`xdg.configFile."opencode/plugins/zellij-attention.ts".source`) — unconditional | generic `event` callback filtering on `event.type === "session.status"` and `event.type === "permission.updated"` |

Key observations from the plugin code:

- The cavemem plugin uses **per-key named hook syntax** (`'session.created': async (input) => {…}`). `input?.sessionID` is the session ID; `input?.callID` is per-tool-call. Errors are swallowed via try/catch so plugin failures never block opencode (`cavemem.js:46-58`). Subprocesses are spawned via `node:child_process.spawn` with `detached: true` + `.unref()` so they outlive the plugin invocation.
- The zellij-attention plugin uses the **generic `event` callback with type discrimination** (`zellij-attention.ts:23-54`). It debounces `permission.updated` by 200ms to avoid false "waiting" signals when permissions auto-resolve. It uses Bun's `$` shell API for subprocess invocation (`await $\`zellij pipe …\`.quiet()`).
- Both patterns are supported by opencode's plugin runtime and can be mixed within a single plugin. The session-compaction plugin will most likely use **per-key named syntax** for the three hooks it cares about (`message.updated` or `message.part.updated`, `experimental.session.compacting`, `session.compacted`).

### 1.2 opencode HM module surface

The shared opencode module lives at `home-manager/common/opencode.nix` (239 lines). Per-host modules layer on top (`configurations/shopify/home-manager/opencode.nix`, `configurations/personal/home-manager/opencode.nix`).

Relevant options for this spec:

- `programs.opencode.commands` (attrset, name → path-to-markdown). Currently declared **only on the Shopify host** (`configurations/shopify/home-manager/opencode.nix:84-88` — three commands: `make-stack-green`, `restack`, `upgrade-environment`). Not declared on the common module. The session-compaction spec needs to decide whether to declare its `/compact` command on the common module (host parity, requires HM mkMerge with the Shopify host's existing commands attrset — which it supports natively) or per-host (host drift risk).
- `programs.opencode.agents` (attrset, name → path-to-markdown) — same shape, declared on common (`opencode.nix:177-183`) and per-host. Not directly used by this spec but a good reference for how attrsets compose.
- `programs.opencode.settings` (freeform attrset) — used for opencode.json contributions. Not directly relevant.
- `home.opencode.wrapperCommands` (list of shell snippets composed into the wrapper) — could be used to export plugin config as env vars if the design phase decides to drive thresholds via env rather than a config file.
- `xdg.configFile."opencode/plugins/<name>".source = ./opencode-plugins/<file>` — the plugin install pattern. Two existing usages cited above.

### 1.3 opencode-cost-diagnosis HM module (the closest precedent)

`home-manager/common/opencode-cost-diagnosis.nix` (141 lines) is the most directly applicable template — same shape this spec needs:

- Top-level options under `programs.opencode-cost-diagnosis.{ enable, package }` (`opencode-cost-diagnosis.nix:83-110`).
- `cfg = config.programs.opencode-cost-diagnosis` + `lib.mkIf cfg.enable { … }` (`opencode-cost-diagnosis.nix:53, 112`).
- `home.packages = [ … ]` for binaries (`opencode-cost-diagnosis.nix:116-120`).
- **`assertions = [{ assertion = config.programs.opencode.enable; message = …; }]`** for peer-module enforcement (`opencode-cost-diagnosis.nix:122-139`). Exactly the pattern Requirement 1.3 calls for.
- Enabled common-wide at `home-manager/common/default.nix:190`.

### 1.4 opencode plugin and SDK API surface (live docs, fetched 2026-05-19)

Confirmed from https://opencode.ai/docs/plugins and https://opencode.ai/docs/sdk:

**Plugin runtime** (`{ project, client, $, directory, worktree }`):
- `client` is a `@opencode-ai/sdk` instance. The SDK exposes `client.session.summarize({ path: { id }, body })` returning `boolean` — programmatic compaction trigger (Requirements 2.3, 2.5, 4.2 source).
- `client.app.log({ body: { service, level, message, extra } })` — structured logging API. Levels: `debug`, `info`, `warn`, `error`. This is the observability log surface for Requirement 6.
- `$` is Bun's shell API; subprocess invocation pattern matches the zellij plugin (`await $\`cavemem search …\`.quiet()`).

**Compaction hook surface** (the load-bearing API for this spec):

```typescript
// experimental.session.compacting hook
{
  "experimental.session.compacting": async (input, output) => {
    output.context.push("...")    // augment the default compaction prompt
    // OR
    output.prompt = "..."         // replace the entire compaction prompt
  }
}
```

When `output.prompt` is set, `output.context` is ignored. The docs explicitly note the `experimental.` prefix — API stability is not guaranteed (Requirement 7.1 / 7.2 source).

**Compaction observability**: `session.compacted` is in the Session Events list (https://opencode.ai/docs/plugins — Session Events block). Fires after compaction completes; payload shape not documented inline.

**Session lineage**: `client.session.children({ path: { id } })` returns child sessions, and `Session` has `parent_id` (per `2026-04-11-opencode-plugin-event-system.md` — types.gen.ts). Useful for distinguishing main from subagent for Requirement 5.

**`message.updated` payload — STILL UNVERIFIED.** Docs list the event name but show no payload. The 2026-04-11 memory documents `session.status`, `session.idle`, `permission.updated` payloads from types.gen.ts, but not `message.updated`. The brief's open question #1 stands.

### 1.5 Steering directory

`.kiro/steering/` currently contains `roadmap.md` and `roadmap-cavemem-integration.md` (archived). No `product.md`/`tech.md`/`structure.md`. The spec's Requirement 4.6 calls for adding `.kiro/steering/session-compaction.md` — pure new markdown, no pattern to match beyond "roadmap-style narrative markdown".

### 1.6 Skills + slash commands (the manual surface)

- **Skills**: 17 vendored via `pkgs.cc-sdd-skills` symlinked individually at `home-manager/common/cc-sdd.nix:69-76`. The cc-sdd module was deliberately designed to permit per-skill `xdg.configFile` additions alongside the cc-sdd ones (per its inline comment), so a custom `kiro-session-compact` skill could ship locally without forking cc-sdd. Whether one is needed is a design-phase decision (Requirement 4 only calls for the slash command and steering doc).
- **Slash commands**: as noted in §1.2, the surface (`programs.opencode.commands`) exists and is host-attrset-merged. Adding a common-module `/compact` command is the clean path for Requirement 4.1; the Shopify host's existing three commands will mkMerge cleanly because they don't collide on name.

### 1.7 cavemem read surface

- **CLI subcommands available today** (verified by viability check): `install, uninstall, status, config, doctor, start, stop, restart, viewer, worker, mcp, search, compress, expand, export, import, hook, reindex`. **No `summarize` subcommand.**
- **MCP tools available today**: `hub_cavemem__list_sessions`, `hub_cavemem__timeline`, `hub_cavemem__get_observations`, `hub_cavemem__search`. (Also accessible from the command line via `cavemem search`.) **No summary-shaped read tool.**
- **Session ID linkage**: `home-manager/common/opencode-plugins/cavemem.js:63` passes opencode's `input?.sessionID` directly into cavemem's `session-start` hook payload. So cavemem indexes observations by opencode's session ID. A future MCP read could be filtered by that ID without any cavemem schema change.
- **No write surface for this spec**: Requirement 3.4 (cavemem read-only during compaction) is satisfied by using only the four MCP tools or the corresponding CLI subcommands. No cavemem changes needed.

### 1.8 opencode-cost-diagnosis library surface (in-process API)

Per `scripts/opencode-cost-report.js:5127-5175`, the cost-report ships as CommonJS with these exports loadable by a plugin: `SqliteReader`, `SchemaDriftError`, `PricingTable`, `SubagentAggregator`, `TokenizerSplitter`, `AttributionEngine`, `FileWriter`, `ReportAssembler`, `ReportSerializer`, `ArgumentParser`, `SessionSelector`, `main`.

`resolveOpencodeDbPath()` returns `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode-stable.db` (`opencode-cost-report.js:4840-4845`, overridable via `OPENCODE_DB_PATH`).

The plugin could `require()` `SqliteReader` directly to read richer per-session context than `message.updated` payloads carry, but that adds a hard dependency on the cost-diagnosis derivation's vendored `better-sqlite3`. **Probably overkill** — the plugin's trigger logic only needs running per-turn token counts, which `message.updated` (or `message.part.updated`) should carry natively. Keep this in the toolbox as a fallback if the event payload turns out to be insufficient.

### 1.9 opencode session compaction artifacts in the DB

Per `.kiro/specs/opencode-cost-diagnosis/design.md:511, 779-780`, opencode persists `part.type == "compaction"` rows in its own SQLite DB when native compaction runs. The cost-report's tokenizer explicitly skips these rows. This means:
- Requirement 6.1 is satisfied trivially: if the plugin successfully invokes `session.summarize`, opencode writes a compaction part automatically; the cost-diagnostic can already see it.
- The plugin does not need to write any artifact to opencode's DB to make compaction events observable.

---

## 2. Requirement-to-Asset Map

Tag legend: ✅ exists / reuse, 🟡 partial / extension needed, 🔧 net-new build, 🔬 unknown — research needed.

| Requirement | Asset | Status | Notes |
|---|---|---|---|
| **R1.1** install on both hosts via declarative pattern | `home.packages` + `xdg.configFile` + new `home-manager/common/session-compaction.nix` | 🔧 | Mirror `opencode-cost-diagnosis.nix`. New ~80-line HM module. |
| **R1.2** rebuild → plugin active on next opencode invocation | `xdg.configFile."opencode/plugins/session-compaction.ts".source` | ✅ pattern | Same install path as cavemem.js / zellij-attention.ts. |
| **R1.3** assert peer module enabled | `assertions = [{ assertion = config.programs.opencode.enable; … }]` | ✅ pattern | Direct copy from `opencode-cost-diagnosis.nix:122-139`. |
| **R1.4** no imperative/network-fetch install | Nix-pure install via vendored TS source file | ✅ pattern | Both existing plugins are vendored verbatim with no `bun install` step. |
| **R1.5 / R1.6** explicit disable + zero residual | `lib.mkIf cfg.enable { … }` | ✅ pattern | Disabling removes `xdg.configFile` symlink + assertion fires only when enabled. |
| **R2.1** per-session token accumulation | Plugin in-memory `Map<sessionID, tokenTotals>` | 🔧 + 🔬 | Trivial state structure. Open question: how/where to read per-turn tokens (R2.1 / R2.3 / R2.5 depend on R7 startup self-check confirming the event surface). |
| **R2.2 / R2.3** token-count threshold + trigger | HM option `thresholdTokens` + plugin compares running total | 🔧 | Trivial; depends on event payload (🔬). |
| **R2.4 / R2.5** wall-clock threshold + trigger | HM option `thresholdWallTimeHours` + plugin checks `Date.now() - sessionStartTime` per event | 🔧 | Trivial. |
| **R2.6 / R2.7** cooldown window | HM option `cooldownMinutes` + per-session last-compaction-at map | 🔧 | Trivial. |
| **R2.8** disabled threshold value | Option validation (zero/null = disabled) | 🔧 | Trivial. |
| **R2.9** opencode compaction unavailable / errors → don't block | `try { await client.session.summarize(...) } catch { app.log(...) }` | ✅ pattern | Matches cavemem.js error-swallow pattern (`cavemem.js:52-58`). |
| **R2.10** no compaction on zero-turn sessions | Per-session turn counter incremented on `message.updated` (or step-finish) | 🔧 | Trivial. |
| **R3.1 / R3.2** pre-compaction query + augment | `'experimental.session.compacting': async (input, output) => { output.context.push(…) }` | ✅ API | Direct opencode-documented usage. Augmenting content sourced from cavemem read tools. |
| **R3.3** graceful degradation when cavemem unreachable | try/catch around cavemem invocation | ✅ pattern | Same swallow pattern as cavemem.js. |
| **R3.4** cavemem read-only during compaction | Use only `cavemem search` / `cavemem hook run` (read-only paths) | ✅ | Cavemem has no write surface this plugin would need. |
| **R3.5** augment-not-replace | Use `output.context.push(...)`; never set `output.prompt` | ✅ API | Direct opencode-documented usage; respecting this is a code convention. |
| **R3.6** augmentation-disable option | HM option `augmentationEnabled` (default true) checked before cavemem query | 🔧 | Trivial. |
| **R4.1 / R4.2** slash command triggering native compaction | `programs.opencode.commands.compact = ./commands/compact.md` — markdown command that opencode renders | ✅ pattern + 🔬 | Pattern exists (Shopify host's three commands). **Open: how a markdown slash command programmatically invokes `session.summarize` vs the LLM doing it via natural-language reasoning.** The opencode `/commands/` markdown surface seems to be LLM-instruction-style, not function-binding. If true, R4.1 might need either (a) plugin-side `tui.executeCommand` interception, (b) a separate skill that the LLM follows to call SDK, or (c) opencode's TUI gaining a native command. Research needed. |
| **R4.3** manual → same augmentation as automatic | Same `experimental.session.compacting` hook fires for both | ✅ API | Manual and automatic both trigger the same compaction code path; the hook fires regardless of caller. |
| **R4.4** zero-turn no-op on manual command | Plugin checks turn count before invoking | 🔧 | Same logic as R2.10. |
| **R4.5** manual failure surfaced clearly | `client.tui.showToast({ body: { message, variant: "error" } })` | ✅ API | Direct SDK call. |
| **R4.6** steering doc at `.kiro/steering/session-compaction.md` | New markdown file | 🔧 | Pure docs work; no pattern beyond roadmap.md style. |
| **R5.1 / R5.2** subagent-watch opt-in, default off | HM option `watchSubagents` (default false) checked in event handler | 🔧 | Trivial. |
| **R5.3** apply thresholds to subagent sessions | Same threshold logic + `client.session.get` to read `parent_id` | ✅ API + 🔬 | SDK supports it; **open: whether `message.updated` fires on subagent sessions** (brief open question #2). |
| **R5.4 / R5.5** subagent-type allowlist | HM option `subagentAllowlist` (list of strings) + check against `session.agent` field | 🔧 + 🔬 | Trivial logic; depends on subagent observability (🔬). |
| **R5.6** graceful degradation if subagent events not observable | Startup self-check warns once and proceeds with main-thread only | 🔧 | Per Requirement 7's self-check. |
| **R6.1** compaction events recoverable by cost diagnostic | opencode native compaction writes `part.type == "compaction"` automatically | ✅ existing | No extra work; cost-diagnostic already sees compaction parts (it skips them, but the row exists). |
| **R6.2** augmentation events recorded with source | `client.app.log({ body: { service: "session-compaction", level: "info", message: "augmented", extra: { sessionID, sourceObservationIDs } }})` | ✅ API | Direct SDK call. |
| **R6.3** operational log on durable path | `client.app.log()` writes to opencode's standard log; documented path resolved from opencode's runtime | ✅ API + 🔬 | Need to confirm where `app.log` actually persists (likely `~/.local/share/opencode/logs/` or similar). Document in module. |
| **R6.4** suppression reasons logged | Every short-circuit path emits an `app.log` with reason | 🔧 | Trivial. |
| **R6.5** startup/shutdown/config logged | Plugin emits config snapshot on `session.created` | 🔧 | Trivial. |
| **R7.1** declared opencode version range | HM module assertion or doc-comment naming the pinned `pkgs.opencode-pinned` version | 🔧 | Trivial. The opencode module pins a version (`home-manager/common/opencode.nix:9-13`); the spec just needs to record the validated range. |
| **R7.2 / R7.3** startup self-check + self-disable on failure | Plugin first-event handler probes for `client.session.summarize` existence and the named hooks; on failure, sets a module-scoped `disabled = true` flag | 🔧 | Custom logic but small. ~30 lines. |
| **R7.4** disabled plugin doesn't interfere | All hook handlers check `disabled` flag first | 🔧 | Convention enforced by plugin code. |
| **R7.5** runtime compaction errors logged, not retried in cooldown | try/catch + per-session "last error at" timestamp respecting cooldown | 🔧 | Trivial. |
| **R7.6** no opencode source mods | Use only `xdg.configFile` + `programs.opencode.*` HM options | ✅ pattern | Both existing plugins satisfy this naturally. |
| **R8.1** coexistence with cost-diagnostic | Both modules enabled simultaneously; no shared state | ✅ by construction | They touch disjoint things. |
| **R8.2** cost-diagnostic continues to load after compaction events | cost-diagnostic already handles `part.type == "compaction"` (skips it) | ✅ existing | Verified at `opencode-cost-diagnosis/design.md:779-780`. |
| **R8.3** no conflict with subagent-context-budget | Both modules separately enableable; orthogonal scopes | ✅ by construction | The in-flight `subagent-context-budget` brief explicitly carves out main-thread context as out-of-scope. |
| **R8.4** no cavemem upstream changes required | Use only existing read surface | ✅ by construction | Read-only constraint captured in R3. |
| **R8.5** continued correctness when tool-output-compressor lands | Compressed outputs reduce per-turn tokens; plugin's running total just reflects what opencode reports | ✅ by construction | Plugin reads opencode's authoritative per-turn counts; no coupling to byte content. |
| **R9.1** measurable cachedReadBreakdown reduction on replay | Re-run `opencode-cost-report` | ✅ pattern | Same diagnostic, re-run before/after. |
| **R9.2** validation workload + methodology documented | Add to module docs / steering | 🔧 | Pure docs work. |
| **R9.3** default thresholds prevent another 30-day session | Choose defaults that would trigger ≤ ~$500 v1 cost (e.g. 500K tokens or 24h wall time) | 🔬 | Brief open question #3; numbers picked in design phase. |
| **R9.4** retune-or-revisit on negative result | Document this as a validation gate, not a code change | 🔧 | Pure docs work. |

**Summary**: of 50+ acceptance criteria, ~70% are covered by existing patterns or are trivial new code; ~10% are net-new logic (~150 lines TS plugin + ~80 lines Nix module + ~150 lines markdown docs); ~5 ACs depend on 3 unresolved research questions (🔬).

---

## 3. Implementation Approach Options

The three options below differ in **where the compaction trigger logic lives** and **how aggressively cavemem is integrated**. All three use opencode's native `session.summarize` for the actual compaction (per the revised Approach A′ from discovery); the differences are upstream of that call.

### Option A: Single plugin, all logic in TS, cavemem invoked via CLI

**Structure**:
```
home-manager/common/session-compaction.nix       (new, ~80 lines)
home-manager/common/opencode-plugins/
    session-compaction.ts                        (new, ~150 lines)
home-manager/common/commands/compact.md          (new, ~30 lines — slash command body)
.kiro/steering/session-compaction.md             (new, ~150 lines)
```

The plugin owns all state (per-session token totals, last-compaction-at, turn counts). It invokes `session.summarize` via the SDK and shells out to `cavemem search` for augmentation context.

- **Trade-offs**:
  - ✅ Single file to reason about; one Nix module + one TS file.
  - ✅ Matches the established pattern (cavemem.js, zellij-attention.ts) exactly.
  - ✅ No new derivations; pure HM-module + symlinked source.
  - ❌ All in-memory state means it doesn't survive plugin reloads (probably acceptable; opencode runs in a long-lived TUI process, and state is per-session-lifetime by design).
  - ❌ Cavemem CLI shell-out has ~50ms overhead per pre-compaction call. Acceptable since compaction itself takes seconds.
- **Effort**: **S** (1–3 days). Pattern is fully established; the new TS code is ~150 lines of straightforward event handling + threshold checks.
- **Risk**: **Medium**. Three research items (event payload shape, subagent event behavior, threshold defaults) could each turn up a surprise that adds 1–2 days of rework.

### Option B: Plugin + standalone Node CLI for the augmentation logic

**Structure**: same as Option A plus:
```
scripts/session-compaction-augment.ts            (new, ~100 lines — Node CLI)
scripts/session-compaction-augment.nix           (new, ~30 lines — buildNpmPackage wrapper)
```

The TS plugin only handles trigger logic and event subscription. When `experimental.session.compacting` fires, the plugin shells out to a separate `session-compaction-augment` binary that owns the cavemem queries, ranking heuristics, and prompt-fragment formatting. The binary is built via `pkgs.callPackage` (same pattern as `opencode-cost-report`).

- **Trade-offs**:
  - ✅ Augmentation logic is testable as a standalone CLI (`session-compaction-augment --session-id X --max-tokens 4000`) without an opencode runtime.
  - ✅ Future augmentation experiments (different ranking heuristics, different cavemem queries, different prompt formats) iterate against the standalone CLI's unit tests, not the live plugin.
  - ✅ Same testing precedent as `opencode-cost-report` / `opencode-cost-diagnosis-node`.
  - ❌ More files and an additional Nix derivation.
  - ❌ Extra subprocess spawn (~50ms) on every compaction. Negligible.
  - ❌ Coordination cost between plugin's in-process state and CLI's stateless invocation; the CLI needs the session ID as input and nothing else.
- **Effort**: **M** (3–7 days). Adds ~130 lines and a new derivation; plugin code is smaller in exchange.
- **Risk**: **Low-Medium**. Same three research items as Option A, but the standalone CLI is easier to write tests against, which de-risks iteration.

### Option C: Pure config-driven approach (no plugin)

**Structure**:
```
opencode.json contribution via programs.opencode.settings.experimental.hook.session_completed = "session-compaction-trigger.sh"  (alternative path)
scripts/session-compaction-trigger.sh            (new, ~80 lines)
home-manager/common/commands/compact.md          (new)
.kiro/steering/session-compaction.md             (new)
```

Use opencode's `experimental.hook.session_completed` config-hook (noted in `2026-04-11-opencode-plugin-event-system.md`) to run a shell script on session idle. The script polls opencode's SQLite DB to read accumulated tokens and decides whether to invoke a separate `cavemem` + `session.summarize` SDK call via `bun`.

- **Trade-offs**:
  - ✅ No plugin code at all; purely declarative + a shell script.
  - ❌ `session_completed` is the wrong trigger semantically — it fires on session idle, which is too late (the cost has already been incurred for the turn). We want pre-turn or mid-turn intervention.
  - ❌ Polling the SQLite DB is racy with opencode's writes; the design team would need to handle WAL-mode concurrency.
  - ❌ Misses the `experimental.session.compacting` hook entirely — no way to inject context into opencode's continuation prompt. Requirement 3 unsatisfiable.
- **Effort**: S (1–3 days) for the script; but Requirement 3 is unsatisfiable.
- **Risk**: **High** — fundamentally cannot meet Requirement 3 (continuation augmentation), so this approach is **rejected** at the requirements level.

---

## 4. Recommendation

**Option A is the recommended starting point**, with an explicit design-phase decision on whether to refactor into Option B's structure once the augmentation logic's complexity is known.

**Rationale**:
1. Option A is the minimum viable shape that satisfies every R1–R9 acceptance criterion.
2. The pattern is fully established by two existing in-tree plugins; reviewer cognitive load is minimal.
3. The augmentation logic's complexity isn't known until the design phase resolves "what cavemem-derived context is actually useful in the continuation prompt?". Premature extraction to a standalone CLI (Option B) might be reorganizing the wrong abstractions.
4. Refactoring Option A → Option B later is mechanical (extract the cavemem-query function into a CLI, replace the inline call with a shell-out). Cheap reversal.

Option C is rejected for not meeting Requirement 3.

---

## 5. Out-of-Scope for Gap Analysis (deferred to design)

The following decisions are explicitly **deferred to design phase** rather than guessed here:

1. **Event-source choice**: `message.updated` vs `message.part.updated` filtered on `step-finish`. Both can in principle carry per-turn token data; the design phase decides based on inspection of `types.gen.ts` or empirical observation against a throwaway plugin.
2. **Subagent event observability**: whether `message.updated` (or whichever event is chosen above) fires on subagent sessions and what `sessionID` is reported in the payload. Determines Requirement 5's feasibility.
3. **Threshold default values**: the brief flagged this as design-phase. Defaults should be chosen so they would have fired ≥ once on the 27 long-running sessions in the 2026-05-19 diagnostic but not on healthy short sessions. Validate against v1 / v2 diagnostic replay.
4. **Slash command mechanism**: opencode's `programs.opencode.commands` surface accepts a markdown body, but it's not yet clear whether that markdown is parsed as LLM instructions (the LLM then chooses to invoke `session.summarize` via reasoning) or as a direct function binding. Affects R4.1 / R4.2 implementation. Design phase reads existing command files in `configurations/shopify/home-manager/commands/` to understand the convention and decide.
5. **Skill (`kiro-session-compact`) — ship in v1 or defer?** R4 mandates the steering doc and slash command; a skill is optional. Design decides whether the carry-over protocol is non-trivial enough to warrant a skill.
6. **Cavemem augmentation ranking**: which observations are "high-signal" for continuation? Recent decisions, current focus, references — but the operationalization (cavemem search query, ranking, token-budget) is design-phase work.
7. **Common-module vs per-host commands declaration**: whether `/compact` is declared on the common opencode module (host parity) or per-host (avoids surprising the Shopify-host author). Both work; default to common per the R1 host-parity requirement.

---

## 6. Implementation Complexity & Risk Summary

| Aspect | Estimate | Justification |
|---|---|---|
| **Total effort (Option A)** | **S–M (3–5 days)** | New HM module (80 lines), new plugin (150 lines), new slash command markdown (30 lines), new steering doc (150 lines), unit-test scaffolding. Pattern fully established. |
| **Total effort (Option B)** | **M (5–7 days)** | Add ~130 lines for standalone CLI + Nix derivation. Buys testability. |
| **Risk (Option A)** | **Medium** | Three open research items could each add 1–2 days. Specifically: if `message.updated` doesn't carry tokens, fallback path (re-tokenize via `tiktoken` or read from `step-finish` parts) needs design. |
| **Risk (Option B)** | **Low-Medium** | Same research risks, but standalone CLI is easier to harness for tests, which de-risks iteration. |
| **Reversibility** | **High** | Plugin disable is a one-line HM module change; no migration needed. opencode operates identically with the plugin disabled. |

### Risk register for design phase

- **`experimental.session.compacting` API drift**: the `experimental.` prefix is a real risk. Requirement 7.2's startup self-check covers detection; rollback (disable the plugin) is trivial. Pin the supported opencode version range explicitly in the HM module.
- **opencode prompt-cache TTL vs compaction frequency**: aggressive compaction could push the agent's context below the cache boundary, increasing cache miss rates and the cache-write cost. Validation in Requirement 9.1 must specifically watch `cachedWrite` and not just `cachedReadBreakdown`.
- **Continuation summary quality**: if opencode's native summary loses information the agent needs, the agent will recompute / re-explore. Worst case: compaction increases cost. R9.4 makes this a validation gate.
- **Cavemem query latency**: pre-compaction is on the critical path of the user's turn. Cavemem MCP queries can be slow on a large observation corpus. Mitigation: design a timeout on the augmentation query (e.g., 2s) and skip on timeout (graceful per R3.3).

---

## 7. Recommendations for Design Phase

1. **Adopt Option A** as the starting structure; revisit Option B refactor after augmentation logic crystallizes.
2. **Resolve the three open questions early in design** (not late):
   - Attach a 10-line throwaway plugin to a live opencode session to observe `message.updated` and `message.part.updated` payloads. Capture the result in design.md.
   - Same throwaway plugin: dispatch a subagent and observe whether `message.updated` fires for it and which `sessionID` shows up. Capture the result.
   - Read `~/.local/share/opencode/logs/` (or wherever `app.log` lands) to confirm the operational-log durability path for R6.3.
3. **Investigate the slash-command mechanism** by reading `configurations/shopify/home-manager/commands/make-stack-green.md` and the two siblings to understand whether markdown commands invoke SDK directly or via LLM reasoning. Decide R4.1's binding accordingly.
4. **Set default threshold values empirically** against the 2026-05-19 diagnostic data. Starting hypothesis: 500K tokens **or** 24h wall time **or** 50 turns since last compaction triggers; cooldown 30 minutes. Tune based on what would have triggered on the 27 long-running sessions in the report.
5. **Plan the validation workload** for R9.1 alongside the design — ideally a deterministic synthetic load that exercises the threshold logic, OR a documented procedure to replay a real session.
6. **Plan for the prompt-cache regression risk**: design the validation methodology to read both `cachedReadBreakdown` (target down) AND `cachedWrite` (must not go up disproportionately).

---

---

# Design-Phase Discovery (added 2026-05-19, post-types.gen.ts fetch)

This addendum resolves the three open research items from §5 above. All
three were resolved by a single fetch of opencode's authoritative type
file at https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/sdk/js/src/gen/types.gen.ts.

## D.1 Confirmed: `message.updated` carries cumulative per-turn tokens

`EventMessageUpdated` has `properties: { info: Message }` where
`Message = UserMessage | AssistantMessage`. `AssistantMessage`
includes:

```typescript
cost: number
tokens: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}
```

This is **per-message cumulative** (one assistant message ≈ one LLM
turn). Per-session running total = sum of latest `tokens` values
across all assistant messages for that session. `message.updated` may
fire multiple times per message; dedupe by `info.id` (the message ID)
and keep the latest `tokens` snapshot.

**Decision**: use `message.updated` for trigger logic (not
`message.part.updated`). Simpler payload, fewer events to process,
and the `cumulative-per-message` shape matches what the threshold
logic actually wants.

`message.part.updated` is available as a fallback if per-step
granularity is ever needed — `StepFinishPart` carries the same
`tokens` shape per inner LLM call. Not needed for v1.

## D.2 Confirmed: `Session.parentID` distinguishes main from subagent

`Session.parentID?: string` (optional). When set, the session is a
subagent dispatched from `parentID`'s session. When unset, the
session is main-thread.

**Decision**: `watchSubagents` opt-in (R5) checks `parentID` on
`session.created` via `client.session.get({ path: { id } })`. If
`parentID` is set, the session is a subagent and only watched when
`watchSubagents = true`.

Additional confirmation: subagent name is recoverable from
`AgentPart.name` in the message parts, OR from the agent the
subagent is configured under. For the allowlist check (R5.4 / R5.5),
the simpler path is to read `AgentPart.name` from the subagent
session's first message and match against the allowlist.

## D.3 Confirmed: `session.compacted` event fires post-compaction

`EventSessionCompacted` has `properties: { sessionID: string }`.
Fires after opencode finishes its native compaction (either
auto-triggered or programmatically via `session.summarize`). Useful
for the cooldown-window logic (mark `lastCompactionAt = Date.now()`
on this event, not on the trigger call, so we measure cooldown from
actual completion rather than from request).

## D.4 Confirmed: `CompactionPart.auto: boolean` distinguishes auto vs manual

`CompactionPart` (in opencode's DB) has `auto: boolean`. Auto-triggered
compactions (whether by opencode's internal logic or by our plugin's
`client.session.summarize` call) get `auto: true`. Manually-triggered
ones get `auto: false`.

**Implication**: from the existing cost diagnostic's perspective, it
can't distinguish "this compaction came from session-compaction
plugin" vs "opencode's own internal compaction" — both get
`auto: true`. For R6.1 observability, our plugin's `app.log` emission
is the only way to attribute the compaction to our plugin.

## D.5 Confirmed: opencode has a NATIVE TUI compact command

`EventTuiCommandExecute.properties.command` is a union that includes
the literal `"session.compact"`. `KeybindsConfig` has
`session_compact?: string` for the keybind. This means users can
trigger native compaction via a TUI keybind RIGHT NOW, with no
plugin.

**Implication for R4 (manual surface)**: the value of a custom
`/compact` slash command beyond the existing keybind is that it
(a) integrates with the plugin's augmentation behavior identically
to automatic triggers (R4.3), (b) provides a chat-history-visible
record of when manual compaction was triggered, and (c) can be
documented in the steering doc as the canonical operator action.
The slash command is still net-additive value, but the design
should not duplicate effort opencode already does — the slash
command's role is "tell the plugin to compact", not "perform
compaction".

## D.6 Decision: slash-command mechanism uses `command.executed` event

`Config.command` schema is `{ [name]: { template: string;
description?: string; agent?: string; model?: string; subtask?:
boolean } }`. Slash commands are LLM-rendered templates, not direct
function bindings. The Shopify host's existing three commands
(`make-stack-green.md`, `restack.md`, `upgrade-environment.md`)
follow the pattern of putting LLM instructions in the markdown body.

`EventCommandExecuted` fires with `{ name, sessionID, arguments,
messageID }` when a slash command is dispatched. Plugins can
subscribe.

**Decision**: the `/compact` slash command's markdown body is
minimal — a short note that compaction is being triggered. The
plugin subscribes to `command.executed`, filters on `name ===
"compact"`, and invokes `client.session.summarize` directly. The
LLM doesn't need to interpret the template; the plugin acts on
the event.

This makes the slash command behave identically to the automatic
trigger (R4.3) and avoids the awkward path of relying on LLM
reasoning to call into the SDK.

## D.7 Decision: `Session.time.compacting` is the cooldown signal

`Session.time` is `{ created: number; updated: number; compacting?:
number }`. When opencode is mid-compaction, `compacting` is set to
the timestamp the compaction started. After it completes, the field
remains as the timestamp of the most recent compaction (verified
empirically in the design phase).

**Decision**: cooldown window check reads `Session.time.compacting`
via `client.session.get` when evaluating thresholds. If
`now - compacting < cooldownMillis`, skip. This is more authoritative
than tracking our own `lastCompactionAt` in plugin memory (which
loses state across plugin reloads).

## D.8 Final component decomposition (revising research.md §3 Option A)

Single TS plugin file with these internal seams:

| Seam | Owns | Pure / I/O |
|---|---|---|
| `SessionTokenTracker` | Per-session token-running-total state via `Map<sessionID, { messageTokens: Map<messageID, totals>, startedAt, turnCount }>` | Pure |
| `ThresholdEvaluator` | Given session state + thresholds, returns `{ shouldCompact: bool, reason: string }` | Pure |
| `CavememContextSource` | Spawns `cavemem search` with timeout; returns string or "" | I/O, timeboxed |
| `CompactionInvoker` | Calls `client.session.summarize` with error handling | I/O |
| `PluginSelfCheck` | Runs once on first event, probes API shapes, sets `disabled` flag if mismatch | Pure (in-process) |
| `SessionCompactionLogger` | Wraps `client.app.log` with `service: "session-compaction"` and structured fields | I/O |

All six live in one TS file. Pure seams are unit-testable; I/O seams
are mocked. The plugin's exported async function wires them together.

## D.9 Resolved scope: subagent observability path

From D.1 + D.2: `message.updated` fires for every assistant message
in every session, including subagent sessions. The `sessionID` in the
event payload identifies which session the message belongs to. Our
plugin can:

1. On `session.created`: query `client.session.get({ path: { id } })`
   to read `parentID`. If `parentID` set AND `watchSubagents = false`,
   add the session ID to an ignore list.
2. On `message.updated`: check ignore list; skip if present.

This is a clean implementation path. R5.6's "log a one-time warning"
fallback is unnecessary — `message.updated` provably fires on all
session types.

## D.10 Decision: directory parity for new artifacts

- Plugin: `home-manager/common/opencode-plugins/session-compaction.ts`
  (matches `cavemem.js`, `zellij-attention.ts`).
- HM module: `home-manager/common/session-compaction.nix` (matches
  `opencode-cost-diagnosis.nix`).
- Slash command: `home-manager/common/commands/compact.md` (NEW
  directory — first common-module command. Shopify host commands
  live under per-host `configurations/shopify/home-manager/commands/`;
  promoting `commands/` to common is consistent with R1 host-parity).
- Steering doc: `.kiro/steering/session-compaction.md` (matches
  existing `roadmap.md` style).
- Module include: add to `home-manager/common/default.nix`'s
  `imports` list and enable via the same module pattern as
  `opencode-cost-diagnosis.nix` (see `home-manager/common/default.nix:190`).

## D.11 Updated risk register

The three risks from research.md §6 stand, plus:

- **`Session.time.compacting` semantics not fully documented**: D.7
  assumes the field persists after compaction. If empirically it
  only exists during compaction, the cooldown logic must fall back
  to plugin-side tracking. Implementation should check empirically
  before committing.
- **opencode native auto-compaction interaction**: if opencode's
  own internal compaction trigger fires BEFORE our threshold trips,
  our `experimental.session.compacting` hook still runs (and we
  still augment). But our `app.log` augmentation-event record (R6.2)
  needs to handle "compaction happened that we didn't trigger" —
  the augmentation hook fires either way; only the trigger path
  differs.

## 8. References

- `home-manager/common/opencode-plugins/cavemem.js` (install + spawn pattern)
- `home-manager/common/opencode-plugins/zellij-attention.ts` (generic event handler + Bun shell pattern)
- `home-manager/common/opencode-cost-diagnosis.nix` (HM module template; assertion pattern)
- `home-manager/common/opencode.nix` (`programs.opencode.{commands,agents,settings,rules}`)
- `configurations/shopify/home-manager/opencode.nix:84-88` (existing `programs.opencode.commands` usage)
- https://opencode.ai/docs/plugins (event list + compaction hook example)
- https://opencode.ai/docs/sdk (`session.summarize`, `session.children`, `app.log`, `tui.showToast`)
- `.kiro/specs/opencode-cost-diagnosis/research.md` (parallel precedent for this doc)
- `.kiro/specs/opencode-cost-diagnosis/design.md:511, 779-780, 949-952` (compaction part type; subagent parent_id)
- `memories/2026-04-11-opencode-plugin-event-system.md` (event payload schemas for session/permission events; gap: no message event coverage)
- `memories/2026-04-11-zellij-attention-opencode-plugin.md` (claude-code → opencode hook port pattern)
- `memories/2026-05-15-opencode-cost-diagnosis-discovery.md` (deferred-spec catalog; session-compaction trigger conditions)
- `memories/2026-05-18-v2-diagnosis-canonical-fixture-findings.md` (cost-diagnostic finding kinds; what session-compaction events look like in the report)
