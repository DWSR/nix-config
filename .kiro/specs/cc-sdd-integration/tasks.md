# Implementation Plan

> This spec was materialised retroactively after implementation
> landed. All tasks below are marked complete; each task lists the
> commit SHA on `main` that delivered it. The task numbering follows
> the 7-commit landing order described in the design document.

## Pre-flight

- [x] 0. Decide architecture and confirm with user
  - Surveyed prior memories (cc-sdd, OpenSpec, GitHub Spec Kit, Kiro,
    SDD primer) to confirm cc-sdd is still the right framework
  - Inspected nix-config layout: flake inputs, overlays, HM module
    structure, existing AGENTS.md composition patterns
  - Drafted phased plan, asked user 6 clarifying questions
  - Adjusted plan when user clarified no-CI / no-Graphite constraints
  - _Requirements: 7_

## Phase 1 — overlay package

- [x] 1. Add the cc-sdd CLI derivation to `overlays/misc.nix`
  - `fetchurl` the npm tarball with the sha512 integrity hash from
    the npm registry's `dist.integrity` field
  - `stdenv.mkDerivation` extracts `package/{dist,templates,
    package.json,README.md}` under `$out/lib/cc-sdd/`
  - `makeWrapper ${nodejs}/bin/node $out/bin/cc-sdd --add-flags
    $out/lib/cc-sdd/dist/cli.js`
  - Verify the built binary prints `cc-sdd v3.0.2` on `--version`
  - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - _Boundary: overlays/misc.nix_
  - Commit: `65288f9 chore(overlays): add cc-sdd derivation`

## Phase 2 — skill+template materialisation

- [x] 2. Add the cc-sdd-skills runCommand derivation
  - Invoke `cc-sdd --opencode-skills --lang en --yes --overwrite
    force` inside the Nix sandbox with `HOME=$(mktemp -d)`
  - Split output into `$out/skills`, `$out/kiro-settings`,
    `$out/agents-md`
  - Verify the output contains all 17 kiro-* directories and the
    expected `templates/{specs,steering,steering-custom}` subtree
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - _Boundary: overlays/misc.nix_
  - _Depends: 1_
  - Commit: `ca8bc37 chore(overlays): add cc-sdd-skills materialisation`

## Phase 3 — home-manager wiring

- [x] 3. Create `home-manager/common/cc-sdd.nix` and wire it in
- [x] 3.1 Add the cc-sdd HM module with options + xdg.configFile + home.packages
  - Declare `programs.cc-sdd.{enable,package,skillsPackage}`
  - Compute `skillNames = builtins.attrNames (builtins.readDir
    "${skillsPackage}/skills")` so version bumps pick up new skills
    without code changes
  - For each skill name, generate an `xdg.configFile."opencode/skills/<n>"`
    entry pointing into the skills derivation
  - Add `cfg.package` to `home.packages` so `cc-sdd` lands on PATH
  - _Requirements: 2.1, 2.3, 2.4, 6.1, 6.3, 6.4_
  - _Boundary: home-manager/common/cc-sdd.nix_
- [x] 3.2 Wire the module into `home-manager/common/default.nix`
  - `imports += [ ./cc-sdd.nix ]`
  - `programs.cc-sdd.enable = true`
  - _Requirements: 6.1, 6.2_
  - _Boundary: home-manager/common/default.nix_
  - _Depends: 3.1, 2_
  - Commit: `bb0b199 feat(home-manager): install cc-sdd CLI and kiro-* skills globally`

## Phase 4 — AGENTS.md composition

- [x] 4. Append cc-sdd quickstart to AGENTS.md on both hosts
- [x] 4.1 Author the bridging preamble at `home-manager/common/agents-cc-sdd.md`
  - When-to-use-SDD section
  - Per-project bootstrap section pointing at `cc-sdd-init`
  - "Two memory systems coexist" disambiguation between Obsidian
    vault and `.kiro/steering/`
  - Vault references
  - _Requirements: 4.6_
  - _Boundary: home-manager/common/agents-cc-sdd.md_
- [x] 4.2 Rewrite `programs.opencode.rules` in `home-manager/common/opencode.nix`
  - Path → three-chunk `concatStringsSep` string: agents.md +
    agents-cc-sdd.md + `pkgs.cc-sdd-skills`/agents-md
  - _Requirements: 4.1, 4.4_
  - _Boundary: home-manager/common/opencode.nix_
  - _Depends: 4.1_
- [x] 4.3 Extend Shopify's `programs.opencode.rules` override to four chunks
  - `[memory, cc-sdd preamble, cc-sdd quickstart, graphite]` via
    `lib.mkForce`
  - Add `pkgs` to the module's function args (was `{ lib, ... }`)
  - _Requirements: 4.5_
  - _Boundary: configurations/shopify/home-manager/opencode.nix_
  - _Depends: 4.2_
  - Commit: `8a833c0 docs(agents): wire cc-sdd quickstart into AGENTS.md on both hosts`

## Phase 5 — per-project bootstrap helper

- [x] 5. Build `cc-sdd-init` and wire onto PATH
- [x] 5.1 Author `scripts/cc-sdd-init.nix`
  - `pkgs.writeShellApplication` wrapping a copy from
    `${cc-sdd-skills}/kiro-settings` into `<cwd>/.kiro/settings/`
  - Refuse to overwrite without `--force`
  - Warn (but don't fail) when cwd doesn't look like a project root
  - `chmod -R u+w` on the copy so user can edit
  - Print "next steps" hint including the OpenCode restart nudge
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - _Boundary: scripts/cc-sdd-init.nix_
- [x] 5.2 Import the helper into the cc-sdd HM module and add to `home.packages`
  - `cc-sdd-init = import ../../scripts/cc-sdd-init.nix
    { inherit pkgs; cc-sdd-skills = cfg.skillsPackage; };`
  - `home.packages = [ cfg.package cc-sdd-init ];`
  - _Requirements: 3.1, 6.3_
  - _Boundary: home-manager/common/cc-sdd.nix_
  - _Depends: 5.1, 3_
  - Commit: `bb8bb00 feat(scripts): add cc-sdd-init per-project bootstrap helper`

## Phase 6 — stack-captain extension (Shopify-only)

- [x] 6. Teach `stack-captain` to enforce cc-sdd `_Boundary:_` mechanically
  - Add INVARIANT 15: boundary check HARD STOP after every gt modify,
    before every gt submit
  - Add "Working with cc-sdd specs" section: annotation grammar,
    one-task-one-branch-one-PR mapping, dependency-to-parent
    translation (`gt create --parent`), violation-handling protocol,
    graceful degradation for missing `_Boundary:_` (cc-sdd v3 leaves
    it optional), explicit scoping to when `tasks.md` exists
  - Add three new vault references (cc-sdd framework, SDD primer,
    integration plan)
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_
  - _Boundary: configurations/shopify/home-manager/agents/stack-captain.md_
  - Commit: `4eb22b6 feat(agents): teach stack-captain to enforce cc-sdd task boundaries`

## Phase 7 — retroactive spec materialisation (dogfood)

- [x] 7. Capture this work as `.kiro/specs/cc-sdd-integration/`
- [x] 7.1 Run `cc-sdd-init` in the nix-config repo to bootstrap templates
  - Confirms the helper works end-to-end in the real target repo
  - _Requirements: 3.2_
  - _Boundary: .kiro/settings/_
  - _Depends: 5_
- [x] 7.2 Add `.kiro/settings/` and `.kiro/steering/` to `.gitignore`
  - Templates are regen-able via `cc-sdd-init`; steering is
    created on-demand by `/kiro-steering`. Only `.kiro/specs/` is
    committed.
  - _Requirements: 7.1_
  - _Boundary: .gitignore_
- [x] 7.3 Author the spec tree
  - `spec.json` with phase=implemented, all approvals true
  - `requirements.md` with 7 EARS-style requirements covering CLI
    packaging, global skills, bootstrap helper, AGENTS.md
    composition, boundary enforcement, both-hosts coverage, and the
    direct-to-main landing strategy
  - `design.md` with Overview, Goals/Non-Goals, Boundary
    Commitments (This Spec Owns / Out of Boundary / Allowed
    Dependencies / Revalidation Triggers), Architecture (Existing
    Analysis, Pattern & Boundary Map ASCII diagram, File Structure
    Plan), Decisions (D1–D7), Risks, Requirements Traceability
  - `tasks.md` (this file) with `_Boundary:_` and `_Depends:_`
    annotations on every task, all marked `[x]` with the commit
    SHA that delivered each
  - _Requirements: 7.1_
  - _Boundary: .kiro/specs/cc-sdd-integration/_
  - _Depends: 7.1, 7.2_
- [x] 7.4 Commit Phase 7
  - _Requirements: 7.1, 7.2, 7.3_
  - _Boundary: .kiro/, .gitignore_
  - _Depends: 7.3_
  - Commit: (this commit)

## Validation gates run between each phase

For every commit 1–7, the following gates passed before `git commit`:

- [x] `nix fmt` clean
- [x] `nix flake check --no-build` clean (or, when a commit changed
  no .nix files, the relevant gate was skipped per pre-commit-hooks)
- [x] `nix build --no-link
      '.#darwinConfigurations.ShopifyLaptop.system'
      '.#darwinConfigurations.Brandons-MacBook-Pro.system'`
  realised both host closures
- [x] `nix eval --raw
      '.#darwinConfigurations.<host>.system.drvPath'`
  returned a store path on both hosts
- [x] Pre-commit hooks (nixfmt-rfc-style, statix, deadnix,
  flake-checker, no-tmp-paths, no-builtins-fetch, no-hardcoded-users)
  ran and passed

The following gates remain for the user to perform manually:

- [ ] `sudo darwin-rebuild switch --flake .` on ShopifyLaptop and
  Brandons-MacBook-Pro to activate the new home-manager closure
- [ ] Restart any running OpenCode session to pick up new skills
  (skills are cached at startup, no hot-reload)
- [ ] `ls ~/.config/opencode/skills/` shows 17 kiro-* directories
- [ ] `which cc-sdd && which cc-sdd-init` both resolve
- [ ] Invoke `/kiro-discovery test feature` in a fresh opencode
  session to smoke-test skill discovery and loading
