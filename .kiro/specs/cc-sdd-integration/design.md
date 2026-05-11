# Design Document: cc-sdd-integration

## Overview

This feature brings `cc-sdd` (gotalab/cc-sdd, MIT, npm `cc-sdd@3.0.2`)
under Nix management so that the Kiro-style spec-driven workflow is
available in every OpenCode session on both ShopifyLaptop and
Brandons-MacBook-Pro. cc-sdd was selected from the SDD framework
landscape (cc-sdd, OpenSpec, GitHub Spec Kit, BMAD, Kiro IDE, Tessl,
Plandex, Backlog.md, GSD, smol-ai/developer, gpt-engineer) per
`memories/2026-04-17-spec-driven-development-primer.md` because of its
native OpenCode install path, MIT licensing, Kiro-compatible spec
tuple plus `_Boundary:_`/`_Depends:_` task annotations, and the most
credible autonomous implementer/reviewer/debugger loop of any
framework surveyed.

**Users:** the user (Brandon) on both their work laptop
(ShopifyLaptop) and personal laptop (Brandons-MacBook-Pro). The
integration enables spec-driven development of any project with cc-sdd
skills auto-discovered globally — both nix-config itself and external
projects.

**Impact:** OpenCode sessions on both hosts gain 17 `/kiro-*` slash
commands. AGENTS.md grows by ~150 lines (cc-sdd quickstart + bridging
preamble + the existing rules) on both hosts, plus the existing
Graphite addendum on Shopify. A new `cc-sdd-init` binary lands on
PATH. The Shopify-only `stack-captain` agent gains a 60-line section
on cc-sdd boundary enforcement. No existing functionality is
displaced or broken.

### Goals

- 17 kiro-* skills available globally on both hosts after activation
- One-command per-project bootstrap of `.kiro/settings/templates/`
- Reproducibility: cc-sdd version and skill content pinned in flake
- AGENTS.md composition that preserves Obsidian memory rules verbatim
- Stack-captain mechanically enforces `_Boundary:_` when a cc-sdd
  spec is in flight
- Retroactive spec captured as the dogfood worked example

### Non-Goals

- Replacing make-stack-green or stack-captain's existing workflow
- Replicating Kiro IDE features (PBT, Bugfix Spec, Powers, fileMatch
  steering)
- Upstreaming a `programs.opencode.skills` option to nix-community
- Per-project skill customisation (skills are global; if a project
  wants overrides, it can drop files in its own `.opencode/skills/`,
  which OpenCode discovers ahead of `~/.config/opencode/skills/`)

## Boundary Commitments

### This Spec Owns

- The `cc-sdd` and `cc-sdd-skills` derivations in
  `overlays/misc.nix`
- The `programs.cc-sdd.{enable,package,skillsPackage}` HM module
  shape in `home-manager/common/cc-sdd.nix`
- The bridging preamble in `home-manager/common/agents-cc-sdd.md`
- The `cc-sdd-init` shell-script helper at `scripts/cc-sdd-init.nix`
- The cc-sdd composition layer of `programs.opencode.rules` in both
  `home-manager/common/opencode.nix` and the Shopify override
- The new "Working with cc-sdd specs" section + INVARIANT 15 in
  `configurations/shopify/home-manager/agents/stack-captain.md`
- This spec tree at `.kiro/specs/cc-sdd-integration/`
- The `.gitignore` entries for `.kiro/settings/` and `.kiro/steering/`

### Out of Boundary

- Any other slash command, agent, or skill not in the cc-sdd skill
  set (e.g. nix-pkg, nvim-tailor, security-auditor, vault-curator,
  yb-sleuth — all left unmodified)
- The Obsidian memory-system rules in
  `home-manager/common/agents.md` (read but not edited)
- The pre-existing Graphite addendum in
  `configurations/shopify/home-manager/agents-graphite.md` (read but
  not edited; only the consumption order in `opencode.nix` changes)
- opencode-pinned, the wrapper-stacking pattern, the LSP package
  list — all left untouched
- Any per-project `.kiro/specs/<other-feature>/` content (not
  bootstrapped here)

### Allowed Dependencies

- `pkgs.fetchurl`, `pkgs.stdenv.mkDerivation`, `pkgs.makeWrapper`,
  `pkgs.runCommand`, `pkgs.writeShellApplication`, `pkgs.nodejs` —
  standard nixpkgs build machinery
- `nix-community/home-manager`'s `programs.opencode.{rules,…}` option
  surface — depended on, not modified
- The `cc-sdd-skills` derivation's invariants: `$out/skills`,
  `$out/kiro-settings`, `$out/agents-md` exist and are byte-stable
  across rebuilds

### Revalidation Triggers

The following changes should force a re-check of this design:

- A bump to `pkgs.cc-sdd.version` that adds, removes, or renames a
  kiro-* skill — the `programs.opencode.rules` length and the
  visible skill set will both shift
- A bump to cc-sdd that changes the `.kiro/settings/templates/`
  layout (adds/removes a templates subdirectory) — `cc-sdd-init`
  copies the whole tree, so the helper continues to work, but the
  spec template formats may have evolved
- An upstream `programs.opencode.skills` option landing in
  nix-community/home-manager — would let us drop the per-skill
  `xdg.configFile` listing in favour of the upstream API
- A change to cc-sdd's published distribution shape (e.g. it stops
  shipping pre-built `dist/` and requires a TS compile step) —
  would force a switch from `fetchurl + mkDerivation` to
  `buildNpmPackage`

## Architecture

### Existing Architecture Analysis

The flake already has well-established patterns for:

- Pinned third-party tools via overlay (see `opencode-pinned`,
  `zellij` in `overlays/misc.nix`)
- HM module composition that preserves both common/host-specific
  layers (`home-manager/common/opencode.nix` for the base,
  `configurations/shopify/home-manager/opencode.nix` for the override
  with `lib.mkForce`)
- Wrapper stacking via `symlinkJoin` + `wrapProgram --run` (see
  `programs.opencode.package` in `home-manager/common/opencode.nix`)
- AGENTS.md composition via `lib.concatStringsSep "\n\n"` and
  `builtins.readFile` (the existing Shopify-only Graphite addendum
  already uses exactly this pattern)
- Custom agent files vendored under `agents/` directories and wired
  via `programs.opencode.agents`
- Helper scripts via `scripts/<name>.nix` that wrap
  `pkgs.writeShellApplication`

cc-sdd integration follows all five established patterns; nothing
here is novel architecture.

### Architecture Pattern & Boundary Map

```
                     ┌────────────────────────────────────┐
                     │ overlays/misc.nix                  │
                     │   cc-sdd        (CLI binary)       │
                     │   cc-sdd-skills (skill+template    │
                     │                  materialisation)  │
                     └──────────────┬─────────────────────┘
                                    │ pkgs.cc-sdd, pkgs.cc-sdd-skills
                     ┌──────────────▼─────────────────────┐
                     │ home-manager/common/cc-sdd.nix     │
                     │   options: programs.cc-sdd.{...}   │
                     │   config:  xdg.configFile.*  +     │
                     │            home.packages           │
                     └──┬─────────────────┬───────────────┘
                        │ enabled in      │ imports cc-sdd-init
        ┌───────────────▼──────┐   ┌──────▼─────────────────┐
        │ home-manager/common/ │   │ scripts/cc-sdd-init.nix│
        │   default.nix        │   │   (writeShellApplication│
        │   programs.cc-sdd    │   │    over cc-sdd-skills) │
        │     .enable = true   │   └────────────────────────┘
        └──────────────────────┘
                        │
       ┌────────────────┴───────────────────────┐
       │                                        │
┌──────▼──────────────────┐   ┌─────────────────▼──────────────┐
│ home-manager/common/    │   │ configurations/shopify/        │
│   opencode.nix          │   │   home-manager/opencode.nix    │
│   programs.opencode.rules │   │   programs.opencode.rules    │
│   = [memory, cc-sdd     │   │   = lib.mkForce [memory,       │
│      preamble, cc-sdd   │   │       cc-sdd preamble,         │
│      quickstart]        │   │       cc-sdd quickstart,       │
└─────────────────────────┘   │       graphite]                │
                              └────────────────────────────────┘

                              ┌────────────────────────────────┐
                              │ configurations/shopify/        │
                              │   home-manager/agents/         │
                              │   stack-captain.md             │
                              │   + INVARIANT 15               │
                              │   + "Working with cc-sdd specs"│
                              └────────────────────────────────┘
```

**Architecture Integration**:

- Selected pattern: layered overlay → HM module → per-host
  composition, mirroring the established `opencode` patterns
- Domain/feature boundaries: cc-sdd packaging is in `overlays/`;
  cc-sdd HM wiring is in `home-manager/common/`; per-host AGENTS.md
  composition extension is in the existing `opencode.nix` files;
  agent-prompt extensions are in the existing `agents/` directory.
  Nothing crosses into a domain that wasn't already established.
- Existing patterns preserved: programs.opencode.{rules,commands,
  agents,package,wrapperCommands,lspPackages} unchanged in shape;
  the `lib.mkForce` + `concatStringsSep` AGENTS.md composition
  pattern from the Graphite addendum carried over verbatim;
  `scripts/<name>.nix` writeShellApplication pattern carried over
  from `bump-shopify-taps.nix`.

### File Structure Plan

```
overlays/misc.nix                                      [MODIFIED]
  + cc-sdd derivation (~50 lines)
  + cc-sdd-skills derivation (~40 lines)

home-manager/common/cc-sdd.nix                         [NEW, ~75 lines]
  options.programs.cc-sdd.{enable,package,skillsPackage}
  config: xdg.configFile."opencode/skills/<n>" + home.packages

home-manager/common/default.nix                        [MODIFIED]
  imports += [ ./cc-sdd.nix ]
  programs.cc-sdd.enable = true

home-manager/common/agents-cc-sdd.md                   [NEW, ~80 lines]
  bridging preamble (when SDD applies, two memory systems coexist,
  cc-sdd-init bootstrap, vault refs)

home-manager/common/opencode.nix                       [MODIFIED]
  programs.opencode.rules: ./agents.md  →  three-chunk concat string

configurations/shopify/home-manager/opencode.nix       [MODIFIED]
  programs.opencode.rules: two-chunk concat  →  four-chunk concat
  module signature: { lib, ... }  →  { pkgs, lib, ... }

scripts/cc-sdd-init.nix                                [NEW, ~85 lines]
  writeShellApplication wrapping a copy from cc-sdd-skills derivation

configurations/shopify/home-manager/agents/stack-captain.md  [MODIFIED]
  + INVARIANT 15 (boundary enforcement HARD STOP)
  + "Working with cc-sdd specs" section (~60 lines)
  + 3 new vault references

.gitignore                                             [MODIFIED]
  + .kiro/settings/   (regen via cc-sdd-init)
  + .kiro/steering/   (created on-demand by /kiro-steering)

.kiro/specs/cc-sdd-integration/                        [NEW]
  spec.json
  requirements.md
  design.md           (this file)
  tasks.md
```

## Decisions

### D1. Package cc-sdd from npm tarball, not from GitHub source

**Choice:** `fetchurl` the npm tarball + `stdenv.mkDerivation` +
`makeWrapper` over `pkgs.nodejs`, rather than `buildNpmPackage` from
the GitHub source.

**Rationale:** cc-sdd publishes a pre-built `dist/` in the npm tarball
and declares zero runtime dependencies (only `@types/node`,
`typescript`, `vitest` as devDependencies). Building from source would
require a TypeScript compile step inside the Nix sandbox for no
behavioural benefit. The tarball is integrity-hashed by npm; we use
the published sha512 directly. Bumps require an explicit hash refresh
(per `npm view cc-sdd@<version> dist.integrity`).

**Trade-off:** if upstream stops shipping pre-built `dist/`, we have
to switch to `buildNpmPackage` (with all the lockfile ceremony that
implies). Acceptable; the change is bounded.

### D2. Materialise skills once at build time, not per-activation

**Choice:** `cc-sdd-skills` is a `runCommand` derivation that invokes
the cc-sdd CLI inside the Nix sandbox once per version bump.
home-manager symlinks individual skill directories into
`~/.config/opencode/skills/<n>/` from the derivation output.

**Rationale:** skills are pure data; running cc-sdd per `darwin-rebuild
switch` would be redundant network-free work. Symlinks into the Nix
store give us GC correctness — when an old cc-sdd version is no
longer referenced, the old skill set is collected.

**Trade-off:** `cc-sdd --opencode-skills --yes --overwrite force`
runs in a non-TTY sandbox. `--yes` and `--overwrite force` together
guarantee non-interactive behaviour despite cc-sdd's documented
"prompt-mode falls back to skip in non-TTY" — verified empirically
during phase 2.

### D3. Hybrid skills-global, templates-local model

**Choice:** install skills under `~/.config/opencode/skills/` (global,
Nix-managed) while leaving templates under `<cwd>/.kiro/settings/`
(per-project, materialised by `cc-sdd-init`).

**Rationale:** the user's stated preference (per the planning
exchange) and the natural cc-sdd model. Skills are pure agent prompts
— same content for every project; global is right. Templates can
legitimately diverge per project (organisation conventions); per-cwd
is right. Sed-patching the skill prompts to fall back to a
`~/.kiro/settings/templates/` global default was considered and
rejected as too fragile (skill prompts reference templates in many
shapes; a clean rewrite was not achievable).

**Trade-off:** users must run `cc-sdd-init` once per project before
their first `/kiro-spec-init` invocation. The cost is one shell
command and one commit (or .gitignore line).

### D4. Append cc-sdd quickstart to AGENTS.md, do not let cc-sdd write its own

**Choice:** vendor cc-sdd's bundled `AGENTS.md` content (read at eval
time from the cc-sdd-skills derivation) and concatenate it into
`programs.opencode.rules` after the existing Obsidian rules and a
new bridging preamble.

**Rationale:** the existing `home-manager/common/agents.md` declares
mandatory startup checks (Obsidian vault availability, transcription
rules, memory recall protocol). Letting cc-sdd's installer run
in-place against `~/.config/opencode/AGENTS.md` would be both
incompatible with our Nix-managed AGENTS.md and would risk clobbering
those rules. Vendoring the cc-sdd content into our composition keeps
both intact and lets the user see exactly which chunk came from where.

**Trade-off:** we must remember to refresh the vendored content when
cc-sdd is bumped — but since it's read directly from the
`cc-sdd-skills` derivation output via `builtins.readFile`, this is
automatic.

### D5. Bridging preamble curated by us, not vendored

**Choice:** `home-manager/common/agents-cc-sdd.md` is hand-written
content (in the repo), not derived from cc-sdd output.

**Rationale:** the preamble explains the parts of the integration
that are specific to THIS Nix configuration: skills are global,
`cc-sdd-init` is the per-project bootstrap, the Obsidian and
`.kiro/steering/` memory systems coexist. None of that is in the
upstream cc-sdd documentation. A cc-sdd version bump should not
silently rewrite this guidance.

### D6. Mechanical boundary enforcement on stack-captain (vs documentation only)

**Choice:** stack-captain gets an explicit INVARIANT (#15) declaring
the boundary check a HARD STOP, plus a 60-line "Working with cc-sdd
specs" section spelling out the protocol (parse `_Boundary:_`,
`git diff --name-only`, reject violations, surface to user).

**Rationale:** the user's stated preference (per the planning
exchange). cc-sdd's reviewer subagent already performs this check;
having stack-captain mirror the discipline at the Graphite-stack
boundary catches the case where a task's diff drifts after the
reviewer has already approved it (e.g. during make-stack-green
fixups). Without mechanical enforcement, the annotation is just
documentation that the agent might or might not respect.

**Trade-off:** stack-captain's prompt grows by ~60 lines (token
cost), and the boundary-glob comparison logic is expressed in
markdown prose rather than executable code (the agent must
faithfully execute it). Real validation of the prompt happens
organically the next time stack-captain is used on a Shopify
Graphite stack with a cc-sdd-derived task set.

### D7. Direct-to-main commits, no Graphite, no CI

**Choice:** land the work as 7 sequential commits on `main`, each
gated by local validation (`nix fmt`, `nix flake check --no-build`,
`nix build` for both hosts) before commit, with the repo's existing
pre-commit hooks acting as the final guard.

**Rationale:** the user clarified mid-planning that this repo has no
CI and does not use Graphite. The "stack structure" of 7 logical
units is preserved as 7 commits; the dependency order is preserved
by sequencing.

**Trade-off:** a bad commit gets activated immediately on whichever
host runs `darwin-rebuild switch` first (the user's, not the
agent's). Mitigation: per-commit `nix build` for both hosts catches
all build-time issues before commit; `darwin-rebuild --rollback` is
the runtime safety net.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| cc-sdd bumps a major version and changes the kiro-* skill set IDs | `cc-sdd.version` is pinned; bumps are deliberate. The `cc-sdd-skills` derivation re-materialises the tree and `builtins.readDir` picks up the new skill names automatically — no manual list maintenance. |
| cc-sdd CLI is non-interactive in the Nix sandbox | `--yes --overwrite force` together guarantee non-interactive behaviour. Verified empirically during phase 2. |
| Skill prompts hardcode `.kiro/...` cwd paths and break for users without `cc-sdd-init` | Acknowledged. Bridging preamble in agents-cc-sdd.md tells the user to run `cc-sdd-init` before first SDD work in a project. The skills' "Template Missing" error path also self-documents the required setup. |
| stack-captain's boundary-enforcement prompt drifts (the agent ignores it) | Real validation happens organically the next time stack-captain is used on a Shopify cc-sdd-derived stack. If drift is observed, iterate via a follow-up commit to nix-config. |
| Bad commit gets activated on user's host before manual review | Per-commit `nix build` on both hosts catches build-time issues. `darwin-rebuild --rollback` is the runtime safety net. The agent does not run activation. |
| AGENTS.md grows past a useful size | Current Shopify total: 38KB (memory: 18KB, cc-sdd preamble: 3KB, cc-sdd quickstart: 4KB, graphite: 13KB). Within model context budgets. If it grows further, consider folding less-critical sections into agent-specific (rather than global) prompts. |

## Requirements Traceability

| Requirement | Implementation |
|---|---|
| 1 (CLI packaging) | overlays/misc.nix `cc-sdd` derivation |
| 2 (global skills) | overlays/misc.nix `cc-sdd-skills` + home-manager/common/cc-sdd.nix `xdg.configFile` |
| 3 (per-project bootstrap) | scripts/cc-sdd-init.nix + home-manager/common/cc-sdd.nix `home.packages` |
| 4 (AGENTS.md composition) | home-manager/common/agents-cc-sdd.md + the `programs.opencode.rules` rewrites in both opencode.nix files |
| 5 (boundary enforcement) | configurations/shopify/home-manager/agents/stack-captain.md INVARIANT 15 + "Working with cc-sdd specs" |
| 6 (both hosts apply) | cc-sdd HM module wired into `home-manager/common/`, validated via per-commit two-host build |
| 7 (direct-to-main, no CI) | 7 sequential commits with local validation gates; no `git push` from agent |
