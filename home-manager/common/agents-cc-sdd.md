# Spec-Driven Development with cc-sdd

This host installs the cc-sdd Kiro-style SDD toolset globally via Nix
(see `home-manager/common/cc-sdd.nix`). The 17 `kiro-*` skills below
are available from any project — you do NOT need to run any bootstrap
to invoke `/kiro-discovery`, `/kiro-spec-init`, or any of the
`/kiro-*` slash commands. They are loaded from
`~/.config/opencode/skills/` automatically.

## When to use SDD

Use the cc-sdd workflow for **non-trivial, multi-step work** where
explicit, reviewable intent documents pay off. Concretely:

- Greenfield features whose requirements aren't yet pinned down.
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
`<cwd>/.kiro/settings/templates/` when generating spec artifacts. The
first time you start an SDD feature in a project, run:

```
cc-sdd-init
```

(provided by `scripts/cc-sdd-init.nix` and on PATH via the
`cc-sdd` HM module.) This materialises `.kiro/settings/templates/`,
`.kiro/settings/steering/`, and `.kiro/settings/steering-custom/` from
the Nix-managed cc-sdd template tree. After that, all `/kiro-*` skills
work end-to-end. You can commit `.kiro/` to the project (recommended
for shared specs) or `.gitignore` it (for solo / experimental work).

## Two memory systems coexist

This repo has two distinct "memory" notions; do not confuse them:

- **Obsidian vault** (above): cross-project, cross-session knowledge —
  decisions, patterns, framework research, debugging notes. Persistent
  across machines via Google Drive sync. Always loaded.
- **`.kiro/steering/`** (below, cc-sdd's notion): per-project
  steering documents capturing project-wide conventions
  (`product.md`, `tech.md`, `structure.md`, plus custom files).
  Created via `/kiro-steering`. Project-local; commit to the project.

Both are useful for different scopes. The Obsidian memory rules above
take precedence — start every session with the vault startup check
regardless of whether SDD is being used.

## Vault references

- `memories/2026-04-17-cc-sdd-framework.md` — full framework deep dive
- `memories/2026-04-17-spec-driven-development-primer.md` — when SDD
  helps, when it doesn't, framework comparison, Böckeler's critique
- `memories/2026-05-10-cc-sdd-integration-plan.md` — how this Nix
  integration is wired, the architectural choices made, the risk
  register

---

The remainder of this section is the cc-sdd quickstart, vendored
verbatim from the upstream cc-sdd package via the
`pkgs.cc-sdd-skills` derivation. It documents the slash-command
catalogue, the spec lifecycle, and the skill structure.
