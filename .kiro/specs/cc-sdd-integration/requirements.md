# Requirements Document

## Introduction

This feature integrates `cc-sdd` — a Kiro-style spec-driven development
scaffolder published as the `cc-sdd` npm package by gotalab — into the
DWSR/nix-config flake. The goal is to make `/kiro-*` slash commands
(discovery, requirements, design, tasks, impl, validation, debug,
review) available in every OpenCode session on both the ShopifyLaptop
and Brandons-MacBook-Pro Darwin configurations, under Nix's normal
reproducibility guarantees, with project-local Kiro template overrides
materialisable via a one-line bootstrap helper.

The intent — captured in the user prompt that opened this work — is to
"start moving towards spec driven development for larger pieces of
work both within the nix-config repo and in general". This spec was
materialised retroactively as the dogfood pilot for the workflow it
enables.

## Boundary Context

- **In scope**: cc-sdd CLI packaging via overlay; materialisation of
  the kiro-* skill set + Kiro template tree; home-manager wiring on
  both hosts; AGENTS.md concatenation that preserves the existing
  Obsidian memory-system rules; a per-project `cc-sdd-init` bootstrap
  helper; mechanical `_Boundary:_` enforcement extension to the
  Shopify-only stack-captain agent; one retroactive spec captured as
  the dogfood example.
- **Out of scope**: Replacing `make-stack-green` or `stack-captain`'s
  existing CI / review-loop responsibilities; replicating Kiro IDE
  features cc-sdd does not have (PBT, Bugfix Spec workflow, Powers,
  fileMatch steering); upstreaming a `programs.opencode.skills` option
  to nix-community/home-manager; using cc-sdd to drive any other
  feature in this repo (those will follow as the natural next step).
- **Adjacent expectations**: `programs.opencode.{rules,commands,agents,
  package,wrapperCommands,lspPackages}` continue to behave exactly as
  before. Existing custom agents (security-auditor, nix-pkg,
  nvim-tailor, vault-curator, stack-captain, yb-sleuth) must not
  regress. The Obsidian memory system rules in
  `home-manager/common/agents.md` remain the first chunk of the
  rendered AGENTS.md on every host.

## Requirements

### Requirement 1: Reproducible cc-sdd CLI packaging

**Objective:** As a nix-config user, I want the cc-sdd CLI binary to be
managed by Nix and pinned in the flake, so that I get the exact same
cc-sdd version on every machine and across every rebuild without ad-hoc
`pnpx` invocations.

#### Acceptance Criteria

1. The system shall expose a `cc-sdd` package in the custom-packages
   overlay sourced from a pinned npm tarball with an integrity-hashed
   `fetchurl` invocation.
2. The packaged binary shall execute `dist/cli.js` via the
   Nix-provided `nodejs`, with no reliance on system Node.js, npm, or
   pnpx.
3. When the version field in the derivation is updated, the system
   shall require an explicit hash refresh; silent upstream changes
   shall not be accepted.
4. The cc-sdd binary shall print its version (`cc-sdd v3.0.2` for the
   initial pin) when invoked with `--version`.

### Requirement 2: Globally discoverable kiro-* skills

**Objective:** As an OpenCode user on either host, I want all 17
`kiro-*` skills available in every session from any cwd, so that I can
invoke `/kiro-discovery`, `/kiro-spec-init`, etc. without bootstrapping
each project before I can use SDD.

#### Acceptance Criteria

1. The system shall install each kiro-* skill directory under
   `~/.config/opencode/skills/<name>/`, sourced from a Nix-managed
   materialisation derivation.
2. The materialisation derivation shall produce its skill tree by
   running `cc-sdd --opencode-skills --yes --overwrite force` inside
   the Nix sandbox, capturing the output once at build time.
3. When cc-sdd's version changes and adds or removes a skill, the
   system shall pick up the new skill set automatically without
   requiring edits to the per-skill installation list.
4. The kiro-* skill files shall be Nix-store-symlinks, immutable on
   the user's filesystem.
5. After `darwin-rebuild switch`, the system shall expose all 17
   skills (kiro-debug, kiro-discovery, kiro-impl, kiro-review,
   kiro-spec-batch, kiro-spec-design, kiro-spec-init, kiro-spec-quick,
   kiro-spec-requirements, kiro-spec-status, kiro-spec-tasks,
   kiro-steering, kiro-steering-custom, kiro-validate-design,
   kiro-validate-gap, kiro-validate-impl, kiro-verify-completion).

### Requirement 3: Per-project template bootstrap

**Objective:** As a developer working on a project that wants
spec-driven development, I want a one-command helper to materialise
`.kiro/settings/templates/` in the current project, so that the
already-loaded global skills can read the templates from cwd as cc-sdd
expects.

#### Acceptance Criteria

1. The system shall expose `cc-sdd-init` on PATH on both hosts.
2. When `cc-sdd-init` is run in a directory without an existing
   `.kiro/settings/`, it shall copy
   `${cc-sdd-skills}/kiro-settings/templates`,
   `.../steering`, and `.../steering-custom` into
   `<cwd>/.kiro/settings/` as user-writable files.
3. When `cc-sdd-init` is run in a directory that already has
   `.kiro/settings/`, it shall refuse to overwrite without `--force`
   and exit non-zero with a diagnostic message.
4. When `cc-sdd-init` is run in a directory that does not look like a
   project root (no `.git`, `flake.nix`, or `package.json`), it shall
   emit a warning to stderr but still proceed.
5. The materialised templates shall be byte-identical to the canonical
   tree under the `cc-sdd-skills` derivation output.
6. The helper shall print a "next steps" hint that nudges the user to
   restart any running OpenCode session (skills are cached at startup).

### Requirement 4: Non-destructive AGENTS.md composition

**Objective:** As a user who relies on the Obsidian memory-system
rules in `home-manager/common/agents.md`, I want the cc-sdd quickstart
documentation appended to those rules without modifying or replacing
them, so that the memory system's mandatory startup check and
transcription rules continue to apply.

#### Acceptance Criteria

1. The system shall set `programs.opencode.rules` to a string composed
   of three concatenated chunks in this order: existing
   `home-manager/common/agents.md`; new
   `home-manager/common/agents-cc-sdd.md` bridging preamble; cc-sdd's
   bundled `AGENTS.md` quickstart (sourced from the cc-sdd-skills
   derivation).
4. The first heading in the rendered AGENTS.md on every host shall
   remain `# MANDATORY: Obsidian Memory System`.
5. On Shopify, the existing Graphite addendum
   (`agents-graphite.md`) shall continue to be layered on top of the
   common chunks via `lib.mkForce`, producing
   `[memory, cc-sdd preamble, cc-sdd quickstart, graphite]`.
6. The bridging preamble shall explicitly call out that the Obsidian
   vault and `.kiro/steering/` are two distinct memory systems with
   different scopes that coexist.

### Requirement 5: Mechanical boundary enforcement on stack-captain

**Objective:** As a Shopify developer using stack-captain to drive
multi-PR Graphite stacks, I want the agent to mechanically enforce
cc-sdd's `_Boundary:_` annotations when it operates downstream of
`/kiro-spec-tasks`, so that out-of-scope diffs are caught before they
hit GitHub instead of slipping through into a merged stack.

#### Acceptance Criteria

1. The stack-captain agent shall declare a new INVARIANT making the
   `_Boundary:_` check a HARD STOP that runs after every `gt modify`
   and before every `gt submit`.
2. The agent prompt shall describe the cc-sdd annotation grammar
   (`_Boundary:_`, `_Depends:_`, `_Blocked:_`, `(P)`) and the
   one-task-one-branch-one-PR mapping.
3. The agent shall map `_Depends:_` annotations to
   `gt create --parent <parent-branch>` invocations.
4. When stack-captain detects an out-of-scope path on a stacked
   branch, it shall surface the violating paths and the boundary line
   to the user without silently widening the boundary or splitting
   the diff via `--no-verify`.
5. When `tasks.md` exists for a feature but the active task lacks a
   `_Boundary:_` annotation, the agent shall implement carefully but
   note the missing annotation in its handoff (cc-sdd v3 leaves the
   annotation optional).
6. When no `<repo>/.kiro/specs/<feature>/tasks.md` exists for the
   work in flight, the existing INVARIANTS 1–14 shall continue to
   govern alone.

### Requirement 6: Both hosts apply

**Objective:** As a user with two Darwin configurations
(ShopifyLaptop, Brandons-MacBook-Pro), I want cc-sdd available on
both, so that SDD-driven work isn't gated by which laptop I'm on.

#### Acceptance Criteria

1. The cc-sdd HM module shall be wired into `home-manager/common/`
   (not a host-specific configuration), so that any host importing
   `home-manager/common` picks it up.
2. The system shall ensure both `darwinConfigurations.ShopifyLaptop`
   and `darwinConfigurations.Brandons-MacBook-Pro` evaluate cleanly
   (`nix flake check --no-build`) and build (`nix build .#…system`)
   with the cc-sdd integration enabled.
3. The system shall ensure `cc-sdd` and `cc-sdd-init` land on PATH
   in the rendered home-manager closure on both hosts.
4. The system shall ensure all 17 kiro-* skills appear under
   `xdg.configFile."opencode/skills/<name>"` on both hosts.

### Requirement 7: Direct-to-main commit landing without CI gates

**Objective:** As the maintainer of a personal nix-config repo with
no CI and no Graphite, I want this work to land as a sequence of
direct-to-main commits, each independently buildable, so that the
"stack structure" of the work is preserved as a reviewable history
without forcing a workflow this repo does not use.

#### Acceptance Criteria

1. The system shall land the work as 7 sequential commits on `main`
   (1: cc-sdd derivation; 2: cc-sdd-skills materialisation; 3: HM
   module; 4: AGENTS.md composition; 5: cc-sdd-init helper; 6:
   stack-captain extension; 7: this retroactive spec).
2. Before each commit, the system shall verify that
   `nix fmt`, `nix flake check --no-build`, and
   `nix build .#darwinConfigurations.{both}.system` all pass.
3. The system shall commit through the repo's existing pre-commit
   hooks (nixfmt, statix, deadnix, flake-checker, no-tmp-paths,
   no-builtins-fetch, no-hardcoded-users) without `--no-verify`.
4. The system shall NOT push to `origin/main`; the user retains
   control over when the work goes public.
5. The system shall NOT activate via `darwin-rebuild switch` from
   inside the agent session (system activation requires interactive
   sudo); the user shall run activation manually after the work is
   reviewed.
