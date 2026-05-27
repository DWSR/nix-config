# Spec-Driven Development with cc-sdd

This host installs the cc-sdd Kiro-style SDD toolset globally via Nix
(see `home-manager/common/cc-sdd.nix`). The 17 `kiro-*` skills are
available from any project — no bootstrap required to invoke
`/kiro-discovery`, `/kiro-spec-init`, or any `/kiro-*` slash command.
Skills load from `~/.config/opencode/skills/` automatically.

## When to use SDD

Use cc-sdd for **non-trivial, multi-step work** where explicit,
reviewable intent documents pay off:

- Greenfield features with unset requirements.
- Large refactors / N→N+1 rewrites where a spec anchors acceptable
  behaviour.
- Cross-team / cross-component changes where contracts matter.
- Multi-PR stacks (the cc-sdd `_Boundary:_` annotation maps cleanly
  onto one branch / one PR per task).

Do NOT use SDD for:

- One-file tweaks, typo fixes, small bug patches.
- Exploratory prototypes where the learning *is* the code.
- Work where the spec would be longer than the implementation.

(Per Birgitta Böckeler's critique: applying SDD to a small bug fix
generates "4 user stories with 16 acceptance criteria" — sledgehammer
for a nut. Don't.)

## Per-project bootstrap (templates only)

Skill prompts work globally, but they reference templates in
`<cwd>/.kiro/settings/templates/` when generating spec artifacts.
First time you start an SDD feature in a project, run:

```
cc-sdd-init
```

(Provided by `scripts/cc-sdd-init.nix`, on PATH via the `cc-sdd` HM
module.) Materialises `.kiro/settings/templates/`,
`.kiro/settings/steering/`, and `.kiro/settings/steering-custom/` from
the Nix-managed cc-sdd template tree. After that, all `/kiro-*` skills
work end-to-end. Commit `.kiro/` to the project (recommended for
shared specs) or `.gitignore` it (solo / experimental).

## Two memory systems coexist

This repo has two distinct "memory" notions; do not confuse them:

- **Obsidian vault** (above): cross-project, cross-session knowledge —
  decisions, patterns, framework research, debugging notes. Persistent
  across machines via Google Drive sync. Always loaded.
- **`.kiro/steering/`** (cc-sdd's notion): per-project steering
  documents capturing project-wide conventions (`product.md`,
  `tech.md`, `structure.md`, plus custom files). Created via
  `/kiro-steering`. Project-local; commit to the project.

Both useful for different scopes. Obsidian rules above take precedence
— start every session with the vault startup check regardless of
whether SDD is being used.

## Vault references

- `memories/2026-04-17-cc-sdd-framework.md` — full framework deep dive
- `memories/2026-04-17-spec-driven-development-primer.md` — when SDD
  helps, when it doesn't, framework comparison, Böckeler's critique
- `memories/2026-05-10-cc-sdd-integration-plan.md` — how this Nix
  integration is wired, the architectural choices made, the risk
  register

## Skills Structure
Skills are located in `.opencode/skills/kiro-*/SKILL.md`
- Each skill is a directory with a `SKILL.md` file
- Use `/skills` to inspect currently available skills
- Invoke a skill directly with `/kiro-<skill-name>`
- **If there is even a 1% chance a skill applies to the current task, invoke it.** Do not skip skills because the task seems simple.
- `kiro-review` — task-local adversarial review protocol used by reviewer subagents
- `kiro-debug` — root-cause-first debug protocol used by debugger subagents
- `kiro-verify-completion` — fresh-evidence gate before success or completion claims

## Workflow

- **Discovery (entry point):** `/kiro-discovery "idea"` — determines
  action path; writes `brief.md` (+ `roadmap.md` for multi-spec).
- **Guided specification:** `@kiro-spec-orchestrator` — runs discovery →
  init → requirements → research/gap validation → design → design validation
  → pre-task ambiguity review → tasks. It stops before implementation.
- **Phase 1 (Specification):** single → `/kiro-spec-quick {feature}
  [--auto]`, or step-by-step (`/kiro-spec-init "description"` →
  `/kiro-spec-requirements {feature}` → optional
  `/kiro-validate-gap` → `/kiro-spec-design {feature} [-y]` → optional
  `/kiro-validate-design` → `/kiro-spec-tasks {feature} [-y]`).
  Multi-spec → `/kiro-spec-batch` (parallel by dependency wave).
- **Phase 2 (Implementation):** `/kiro-impl {feature} [tasks]`. Without
  task numbers → autonomous (subagent per task + independent review +
  final validation). With task numbers → manual (selected tasks in
  main context, still reviewer-gated).
- **Validation:** `/kiro-validate-impl {feature}` (standalone re-run).
- **Progress check:** `/kiro-spec-status {feature}` (anytime).

3-phase approval workflow: Requirements → Design → Tasks →
Implementation. Human review required each phase; use `-y` only for
intentional fast-track.

## Spec writing style

cc-sdd's templates can produce 5,000-line specs for moderately-scoped
features when the LLM defaults to "fill every heading exhaustively"
and "restate context for clarity." Apply these negative rules to
every `/kiro-spec-*` output (brief.md, requirements.md, design.md,
tasks.md, research.md).

### Prose rules (all spec documents)

Do not write:

- **Rationalizing tails on EARS criteria.** The Objective line states
  the why once. Acceptance criteria are assertions, not narrated
  motives. Bad: "The Disk Generator shall not emit
  `systemd-udev-settle`, so boot is not blocked." Good: "The Disk
  Generator shall not emit `systemd-udev-settle`."
- **Phatic preambles.** Forbid: "This section discusses…", "Applied
  the lenses…", "Outcomes captured here so…", "It is worth noting…",
  "In summary…". Start with the substance.
- **Defensive padding.** Forbid "cheap insurance", "forward-compat",
  "in some cases", "potentially", "may be needed in the future" as
  decision justifications. One-line decisions get one line. If you
  cannot justify the decision in one sentence, the decision may not
  be needed.
- **Bold-tag-then-explain when a single sentence works.** The
  `**Field**: value` rhythm is for tables and reference data, not
  for paragraphs whose every field has one trivial fact.
- **ALL CAPS for emphasis.** Reserve uppercase MUST / SHALL /
  MUST NOT for EARS acceptance criteria. Design prose uses sentence
  case.
- **Hedged language.** "X", not "X (likely)" / "in some cases X" /
  "potentially X" / "this may…". If you genuinely don't know, write
  one sentence saying so and stop.
- **Numbered lists when order does not matter.** Bullets otherwise.

Em-dash budget: at most one per paragraph.

### Cross-document de-duplication

The five spec documents have distinct purposes. Each downstream
document MUST NOT restate context from upstream ones.

- **brief.md** is the source of the problem statement, the approach,
  and the scope decisions. Other documents reference it; they do not
  restate it.
- **requirements.md `## Introduction`** is 1–3 sentences naming the
  feature and pointing at brief.md. `## Boundary Context` (if
  present) is a delta from brief.md's `## Out of Boundary`, not a
  restatement.
- **design.md `## Overview`** is 1–2 sentences.
  `### Existing Architecture Analysis` (if present) is ≤10 lines
  describing what is changing, not a re-tour of the current system.
  `## Boundary Commitments` references requirements.md by section
  name and states only deltas.
- **design.md `## Components and Interfaces`** describes contracts
  and responsibilities. It MUST NOT inline full implementation code
  (complete unit files, full config snippets, function bodies); those
  belong in tasks and code review. Code blocks here are signatures,
  schemas, and small fragments only.
- **tasks.md** states WHAT each task does, not WHY. The why is in
  design and requirements. Observable Completion is one fragment.
- **research.md** captures *new information found during discovery*
  (external quirks, version compatibility, benchmarks). Decisions
  that flow from that research belong in design.md. Combined
  Synthesis + Gap Analysis sections cap at 100 lines; if longer, you
  found a scope problem, not a documentation need.

When the same fact is genuinely needed in two places (e.g. a contract
that both design.md and tasks.md reference), state it in one place
and link by section name.

### Soft line caps

Treat these as the threshold at which to ask "should this be split?"
rather than "should I keep writing?":

| Document        | Cap (lines)                                       |
|-----------------|---------------------------------------------------|
| brief.md        | 150                                               |
| requirements.md | 500                                               |
| design.md       | 1200                                              |
| research.md     | 400                                               |
| tasks.md        | ~12 lines per task (check density, no total cap)  |

Counts include every line (headings, blanks, bullets, code, tables).
If a document exceeds its cap, stop and ask the user whether the
spec should be split into multiple smaller specs. Do not raise the
cap to fit the content.
