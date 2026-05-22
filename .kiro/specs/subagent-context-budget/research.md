# Implementation gap analysis: subagent-context-budget

Generated: 2026-05-22

## Scope

This analysis maps `.kiro/specs/subagent-context-budget/requirements.md` to the existing nix-config codebase. The feature is brownfield: opencode, mcpproxy, subagent definitions, and the cost diagnostic already exist; the missing work is budget enforcement, audit output, validation glue, and smoke tests.

Core steering files `product.md`, `tech.md`, and `structure.md` were absent in this checkout. Relevant context came from the feature requirements, roadmap/spec artifacts, existing opencode Home Manager modules, local agent files, opencode docs, and the current opencode JSON schema.

## Current state

- Common opencode configuration is rendered through `home-manager/common/opencode.nix`, which wraps `pkgs.opencode-pinned`, composes `programs.opencode.rules`, and registers common subagents through `programs.opencode.agents` (home-manager/common/opencode.nix:199-244).
- The `home.opencode.agentWithCaveman` helper already performs per-subagent prompt composition at Nix evaluation time when `home.opencode.enableCaveman` is enabled (home-manager/common/opencode.nix:35-49,75-83).
- Shopify overrides the common rules string to add Graphite guidance and adds host-specific agents through the same agent attrset (configurations/shopify/home-manager/opencode.nix:57-63,120-123).
- Both hosts reach MCP through one remote `mcpproxy` entry in opencode; mcpproxy itself uses `routing_mode = "retrieve_tools"` and renders all upstream servers into one routeable surface (home-manager/mcp/default.nix:111-119, configurations/shopify/home-manager/opencode.nix:146-152).
- Existing custom subagents use `permission` blocks, not `tools` blocks. Examples: `nix-pkg` allows edits/webfetch and selected shell commands, while `vault-curator` and `vault-synthesizer` deny repo writes/webfetch and allow only local search shell commands (home-manager/common/agents/nix-pkg.md:6-27, home-manager/common/agents/vault-curator.md:6-19, home-manager/common/agents/vault-synthesizer.md:6-19).
- OpenCode 1.15.5 is pinned in the overlay (overlays/misc.nix:213-223). The current opencode schema marks `agent.*.tools` as deprecated and directs new configurations toward `permission` instead (https://opencode.ai/config.json, https://opencode.ai/docs/agents/).
- `opencode-cost-report` already has a subagent rollup. `SubagentAggregator.rollup()` returns `byAgent` and null-agent residual data from descendant `session.parent_id` rows (scripts/opencode-cost-report.js:772-819,886-958).
- v2 cost attribution already emits `cost.subagentDispatchByAgent` from the aggregator (scripts/opencode-cost-report.js:2292-2326) and tool-output by-tool data from the tokenizer/cost pipeline (scripts/opencode-cost-report.js:2531-2633).
- Existing validation patterns include HM peer assertions and PATH-installed tools in `programs.opencode-cost-diagnosis` (home-manager/common/opencode-cost-diagnosis.nix:83-140), plus fixture-backed Node tests and smoke tests for diagnostics.

## Requirement-to-asset map

| Requirement area | Existing assets | Gap |
|---|---|---|
| R1 inventory and baseline audit | `programs.opencode.agents`, host-specific agent merges, `opencode-cost-report` session DB readers | Missing audit CLI/report that enumerates rendered agents, first-turn token counts, exposed context, and observed tools. |
| R2 per-agent tool budgets | Agent `permission` frontmatter, OpenCode permission schema | `tools` is deprecated; design must translate the requirement into permission-level budgets or justify use of deprecated `tools`. Built-in agents need override strategy. |
| R3 role-scoped instructions | `programs.opencode.rules`, Shopify `mkForce`, `agentWithCaveman` prompt concatenation | No per-agent AGENTS.md/instruction splitter exists. Need a scoped-instruction mechanism that keeps mandatory memory/mcpproxy rules. |
| R4 minimal read-only baseline | `vault-synthesizer`, `vault-curator`, `security-auditor`, `explore` concept | Missing documented baseline artifact and repeatable measurement. |
| R5 before/after validation | v2 `subagentDispatchByAgent`, Markdown/JSON reports, privacy default | Missing comparator workflow/CLI tying baseline and post-change reports to the 40% pass criterion. |
| R6 capability preservation | Agent descriptions and existing test harness patterns | Missing per-agent smoke tests, especially for direct `opencode run --agent` users such as memory-sync. |
| R7 host parity/control | HM module patterns, host-specific agent and MCP merges | Missing per-agent enable/escape hatch options and audit reporting for disabled/unbudgeted agents. |
| R8 guardrails | Requirements already bound scope | Design must avoid opencode source changes, Task API changes, dispatch caps, session compaction, and tool-output compression. |

## Primary implementation gaps

1. **Tool budget mechanism**: Requirements say explicit tool sets, but OpenCode now deprecates `tools` in favor of `permission`. Existing agent files already use `permission`. Design should decide whether “allowed tool set” means permission-level allow/deny patterns, top-level `tools` despite deprecation, or a plugin/config transform.
2. **Built-in agent budgeting**: `general` and `explore` are cost-relevant built-ins, but this repo only defines custom subagent files plus title/summary/build overrides (home-manager/common/opencode.nix:259-267). Design needs an override plan for built-ins without changing their names.
3. **Instruction scoping**: Today every session gets the composed global rules string. The only existing per-agent prompt transform is `agentWithCaveman`, which appends text to specific agent prompts. There is no existing section-aware AGENTS.md loader.
4. **MCP schema exposure**: mcpproxy retrieve-tools mode already hides individual upstream schemas behind a smaller routeable surface, but per-agent upstream/MCP allowlisting is not represented in the current mcpproxy or opencode config.
5. **First-turn token measurement**: `opencode-cost-report` measures actual completed sessions. A synthetic no-op dispatch harness is still missing for controlled first-turn input counts.
6. **Residual agent attribution**: v2 can fold unknown/null agents into residual buckets. Validation should treat residual size as a data-quality signal, not as proof of a specific agent’s budget effect.
7. **Non-interactive smoke tests**: Existing agents may prompt under permission rules. Smoke tests that invoke agents outside the TUI must avoid hangs while still proving trimmed capabilities.

## Implementation options

### Option A: Extend existing opencode HM module

Add budget options and transformations directly to `home-manager/common/opencode.nix`: per-agent permission maps, per-agent prompt fragments, escape hatches, and rendered metadata.

- Pros: few new files, immediate access to existing agent wiring, easy to keep host parity.
- Cons: risks bloating the central opencode module and mixing audit/validation logic with config rendering.
- Best fit: small first pass focused on custom agents only.

### Option B: Create a new `programs.subagent-context-budget` module and helper CLI

Create a separate HM module that consumes opencode config, installs an audit/validation CLI, renders per-agent budget metadata, and contributes overrides to `programs.opencode.agents/settings`.

- Pros: clearer ownership, testable in isolation, mirrors `programs.opencode-cost-diagnosis` and `programs.session-compaction` patterns.
- Cons: needs careful integration with existing `programs.opencode.agents` and host merges; may duplicate some opencode knowledge.
- Best fit: full requirement coverage including audit, validation, smoke tests, and escape hatches.

### Option C: Hybrid

Keep small reusable primitives in `home-manager/common/opencode.nix` (for prompt section composition and agent override merging), and put audit/validation, options, tests, and operator docs in a new feature module.

- Pros: avoids overloading opencode.nix while reusing the existing agent-rendering seam; supports phased rollout.
- Cons: more design coordination and more moving parts.
- Best fit: likely most compatible with requirements R1-R7.

## Complexity and risk

- Effort: **L (1-2 weeks)**. The codebase has strong patterns, but this feature spans HM config rendering, opencode agent semantics, diagnostic parsing, shell/Node test harnesses, and host-specific validation.
- Risk: **Medium-High**. The highest risks are deprecated `tools` semantics, built-in agent overrides, and whether instruction scoping can materially reduce first-turn tokens without breaking mandatory memory rules.

## Research needed for design

1. Confirm in the pinned OpenCode version whether agent-level `permission` denial removes tools from the system prompt or only gates execution. The docs state denied `permission.task` removes subagents from Task descriptions, but built-in/MCP schema prompt effects need empirical proof.
2. Confirm whether built-in `general` and `explore` can be overridden with `agent.general` / `agent.explore` permission and prompt fields without losing built-in behavior.
3. Measure the rendered system prompt delta for: current global rules, common-only rules, Shopify Graphite addendum, caveman snippet, and mcpproxy retrieve-tools schema.
4. Decide whether per-agent instruction scoping uses prompt inlining, multiple generated agent files, opencode `instructions`, or an opencode plugin `config` hook.
5. Define the no-op dispatch harness and representative smoke task for each agent type.
6. Define acceptance handling for residual `(unknown)` / below-threshold subagent attribution in v2 diagnostic reports.

## Design-phase recommendation

Carry forward Option C as the leading design candidate, with Option B as the clean-separation fallback if the opencode module seam becomes too invasive. Treat `permission` as the likely budget mechanism unless empirical testing shows it does not reduce prompt/tool schema context; avoid the deprecated `tools` field unless no supported alternative meets R2.

---

# Design discovery addendum

Generated: 2026-05-22T03:04:13Z

## Summary

- **Feature**: `subagent-context-budget`
- **Discovery Scope**: Extension with complex integration seams.
- **Key Findings**:
  - OpenCode `tools` is deprecated; `permission` is the supported budget surface.
  - Built-in agents can be overridden through `agent.<name>` without changing their names.
  - Per-agent instruction subtraction is not a public config feature; runtime prompt filtering needs an opencode plugin and validation.

## Research Log

### OpenCode agent and permission contract

- **Context**: Requirements use “allowed tool sets”; the brief used `tools` terminology.
- **Sources Consulted**: OpenCode agent docs, permission docs, config schema.
- **Findings**:
  - `tools` remains accepted but is deprecated as of v1.1.1.
  - `permission` is the current tool-control surface.
  - Agent permissions override global permissions.
  - `permission.task` controls which subagents a caller can invoke and can remove denied subagents from Task descriptions.
- **Implications**:
  - The design treats “tool budget” as a per-agent permission budget.
  - The design does not use the deprecated `tools` field.
  - The first implementation task should empirically confirm prompt/schema impact, because docs describe behavior gating more directly than token-context pruning.

### Built-in subagent overrides

- **Context**: `general` dominates known subagent cost, but it is built in.
- **Sources Consulted**: OpenCode agent docs, config schema, local `opencode.nix` overrides.
- **Findings**:
  - The schema exposes `agent.general`, `agent.explore`, and `agent.scout` as overrideable keys.
  - This repo already overrides hidden built-ins `title` and `summary`, and Shopify overrides `build`.
- **Implications**:
  - Built-in budget enforcement should use `programs.opencode.settings.agent.<name>` overrides rather than adding new agent names.
  - Smoke tests must include both built-in and custom subagents.

### Instruction scoping mechanism

- **Context**: Requirements demand role-scoped instruction context, but global `AGENTS.md` applies across sessions.
- **Sources Consulted**: OpenCode rules docs, config schema, plugin memory note.
- **Findings**:
  - `instructions` is top-level config, not an `AgentConfig` field.
  - Agent `prompt` adds role-specific content; it does not remove global rules.
  - Plugin hooks include chat/system transform hooks in local type references, but agent detection at that hook must be prototyped.
- **Implications**:
  - The design uses a runtime plugin for subagent-only instruction filtering.
  - The plugin is a supported-extension path, not an opencode source modification.
  - Validation must fail if the plugin cannot identify subagent sessions or cannot prove prompt reduction.

### Existing cost diagnostic reuse

- **Context**: Validation must compare `subagentDispatch` before/after.
- **Sources Consulted**: `opencode-cost-report` implementation and v2 requirements.
- **Findings**:
  - `SubagentAggregator` already groups descendants by `session.agent`.
  - v2 emits `subagentDispatchByAgent` and tool-output by-tool data.
  - Residual unknown-agent buckets can be large and must be treated as data quality signals.
- **Implications**:
  - The design adds a parser/comparator around existing report JSON instead of a second cost model.
  - Residual buckets are reported separately and cannot be credited to specific budgeted agents.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend `opencode.nix` only | Add all rendering, metadata, and validation there | Minimal new module count | Bloats central config and mixes runtime validation with config rendering | Rejected as primary |
| New standalone HM module | Own all budgets, metadata, plugin, CLIs | Clear responsibility boundary | Needs integration with existing agent rendering | Viable fallback |
| Hybrid | Keep small opencode helper seams and own feature logic in a new module | Preserves existing patterns and isolates budget logic | More coordination between module and helper | Selected |

## Design Decisions

### Decision: Permission budgets replace deprecated tool allowlists

- **Context**: R2 requires allowed tool sets; OpenCode deprecates `tools`.
- **Alternatives Considered**:
  1. Use `tools` anyway.
  2. Use `permission` budgets.
- **Selected Approach**: Use `permission` budgets.
- **Rationale**: This follows OpenCode’s current schema and docs.
- **Trade-offs**: Permission budgets may require empirical measurement to prove schema-context reduction.
- **Follow-up**: First implementation task measures first-turn token deltas under permission budgets.

### Decision: Runtime instruction filtering via plugin

- **Context**: Per-agent `instructions` is not a public config field.
- **Alternatives Considered**:
  1. Add role text to agent prompts only.
  2. Split global AGENTS.md and rely on top-level `instructions`.
  3. Filter subagent system prompts via plugin.
- **Selected Approach**: Filter subagent system prompts via plugin and retain global main-thread rules.
- **Rationale**: It is the only path that can remove global reference material from subagent context without changing opencode source.
- **Trade-offs**: Plugin hook compatibility must be proved on the pinned OpenCode version.
- **Follow-up**: Include a prototype/self-check task and fail closed if the hook is unavailable.

### Decision: Reuse `opencode-cost-report`

- **Context**: R5 requires before/after diagnostic comparison.
- **Alternatives Considered**:
  1. Reimplement cost attribution in the new CLI.
  2. Parse existing diagnostic JSON.
- **Selected Approach**: Parse existing diagnostic JSON.
- **Rationale**: The roadmap makes the diagnostic the shared measurement primitive.
- **Trade-offs**: The validation CLI inherits report-shape drift risk.
- **Follow-up**: Validate required fields and emit actionable errors when fields are absent.

## Risks & Mitigations

- Plugin cannot identify subagent sessions — add startup self-check and fail validation rather than silently claiming role-scoped instruction enforcement.
- Permission budgets do not reduce model-visible schemas enough — measure first-turn deltas and treat the result as a validation gate.
- Built-in agent overrides drift — validate rendered config against `https://opencode.ai/config.json` and smoke-test direct invocation.
- Unknown-agent residual buckets hide savings — report residuals separately and exclude them from per-agent reduction claims.

## References

- OpenCode agents docs: https://opencode.ai/docs/agents/
- OpenCode permissions docs: https://opencode.ai/docs/permissions/
- OpenCode rules docs: https://opencode.ai/docs/rules/
- OpenCode config schema: https://opencode.ai/config.json
