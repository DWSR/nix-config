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
