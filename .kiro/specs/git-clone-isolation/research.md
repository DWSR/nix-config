# Implementation Gap Analysis: git-clone-isolation

## Context

Requirements are generated but not yet approved in `spec.json`; this analysis proceeds because gap validation can inform design and requirement revisions. Core steering files `product.md`, `tech.md`, and `structure.md` are absent from `.kiro/steering/`, so repo context comes from the discovery brief, requirements, local module/script patterns, and the Graphite playbook.

## Current State Investigation

### Existing assets and conventions

- Git configuration is already centralized through Home Manager. Common settings enable Git, set `init.defaultBranch = "main"`, enable rebase-oriented defaults, and configure signing/LFS in `home-manager/common/git.nix:2` and `home-manager/common/git.nix:16`.
- `~/scratch` already exists as a managed workspace root via Home Manager activation in `home-manager/common/default.nix:122`.
- `zellij-worktree` uses the same scratch root and remains an adjacent workflow, not the owner of this feature, in `home-manager/common/zellij.nix:154` and `home-manager/common/zellij.nix:157`.
- Script-style local tools commonly use `writeShellApplication` with explicit `runtimeInputs`, as shown by `scripts/rtk-opencode-smoke-test.nix:13` and `scripts/rtk-opencode-smoke-test.nix:15`.
- Common Home Manager feature modules expose `programs.<feature>.enable`, package options, metadata paths, assertions, and `home.packages` wiring; `home-manager/common/subagent-context-budget.nix:102` and `home-manager/common/subagent-context-budget.nix:187` are the nearest shape match.
- Flake checks run Node suites in isolated writable source copies with temporary `HOME`, matching the fixture strategy needed for local Git remotes in `flake.nix:281` and `flake.nix:290`.
- Graphite guidance explicitly calls out shared worktree metadata and cross-worktree cache poisoning as known failure modes in `configurations/shopify/home-manager/agents-graphite.md:8`, `configurations/shopify/home-manager/agents-graphite.md:43`, and `configurations/shopify/home-manager/agents-graphite.md:86`.

### Existing capability coverage

- **Present**: Declarative Git config, Git hooks, scratch directory, zellij worktree plugin, script packaging patterns, flake test patterns.
- **Missing**: A CLI that maintains a bare base-branch cache, creates isolated clones from it, rewrites remotes, and verifies no alternates dependency remains.
- **Missing**: A Home Manager module for clone-isolation defaults and package installation.
- **Missing**: Fixture tests for local upstream repos, bare cache refresh, clone independence, remote rewrite, and post-cache-removal clone usability.

## External Dependency Findings

- Git supports `git clone --reference-if-able=<repo>` to borrow objects from a local reference and reduce transfer cost. Git's own docs warn that this uses alternates and inherits the same risks as `--shared` unless the clone is dissociated.
- Git supports `git clone --dissociate`, which borrows from reference repositories during clone and then copies required objects so the new clone stops borrowing.
- Git `clone --mirror` is broader than the requirements: it maps all refs and configures future remote updates to overwrite all refs. This conflicts with the main-only cache requirement.
- Git `fetch` supports explicit refspecs and `--no-tags`, which fit a main-only cache better than mirror semantics.
- Git `remote set-url` is the stable porcelain for rewriting the generated clone's `origin` to the original upstream.
- The XDG Base Directory Specification defines `$XDG_STATE_HOME` for user-specific state that persists across application restarts but is not important or portable enough for data home. That matches a reconstructable operational cache better than committed data.

## Requirement-to-Asset Map

| Requirement | Existing assets | Gap classification | Notes |
|---|---|---|---|
| 1. Cache lifecycle | Git installed/configured; script packaging patterns | Missing | Need cache root resolution, cache naming, init/update command, main-only fetch refspec, error behavior. |
| 2. Isolated working clone creation | `~/scratch` activation; Git CLI | Missing | Need clone command, destination safety checks, `--dissociate`, and proof that generated `.git` is independent. |
| 3. Upstream remote and branch state | Git remote behavior; common Git defaults | Missing | Need cache-vs-upstream remote model and branch checkout/reporting behavior. |
| 4. Declarative install/config | Existing HM module conventions | Missing | Need new common module, package option, defaults for cache root/clone root/base branch, and package exposure. |
| 5. Graphite and adjacent boundaries | Graphite playbook; zellij worktree plugin | Constraint | Requirements should preserve no-`gt`, no-worktree, no-zellij-change boundaries. |
| 6. Network-free verification | Flake check and Node test patterns | Missing | Need local fixture repos and tests for cache, clone, remote, metadata isolation, and cache deletion. |

## Implementation Options

### Option A: Extend existing Git/Home Manager config

Add the CLI package directly to `home-manager/common/default.nix` and place defaults in existing Git config.

- **Pros**: Few files; fastest wiring; uses existing common Git module.
- **Cons**: Blurs responsibilities in generic Git config; no feature-level enable/disable switch; harder to test rendered module behavior independently.
- **Fit**: Weak. Existing Git config owns user defaults, not an operator workflow tool.

### Option B: Create new CLI and Home Manager module

Add a dedicated script derivation under `scripts/`, a `home-manager/common/git-clone-isolation.nix` module, focused tests, and a flake check.

- **Pros**: Clean responsibility boundary; testable in isolation; matches existing feature-module patterns; preserves adjacent Git/zellij behavior.
- **Cons**: More files; requires module option design; requires explicit test harness for local fixture remotes.
- **Fit**: Strong. The requirements define a distinct tool with package/config/test surfaces.

### Option C: Hybrid CLI-first, module later

Implement a CLI and expose it through `home.packages`, then add module options after behavior stabilizes.

- **Pros**: Faster first slice; reduces module-design work up front.
- **Cons**: Fails the declarative configuration requirement until phase two; risks redesign when module options arrive; weaker parity validation.
- **Fit**: Moderate only if scope is reduced; current requirements already include the module.

## Technical Gaps and Design Questions

- **Cache identity**: Need a deterministic, collision-resistant mapping from upstream URL + branch to a cache path. Research/decide whether to use sanitized URL plus hash, full hash only, or user-provided cache name.
- **Default path expansion**: Need a consistent shell-side model for `$XDG_STATE_HOME` fallback and `~/scratch` expansion. Existing repo conventions prefer XDG fallbacks and avoiding hardcoded `/Users` paths.
- **Clone independence verification**: Tests should inspect absence of `.git/objects/info/alternates` or prove clone works after cache removal. The latter is already required and should be primary.
- **Submodules and Git LFS**: Requirements do not mention cloning submodules or LFS object materialization. Design should decide whether to explicitly leave both to normal post-clone Git behavior or add options.
- **Concurrent cache refresh**: Requirements do not mention locking. Design should decide whether first implementation needs a lock around cache update to avoid two invocations mutating the same bare cache.
- **Base branch naming**: Common Git config defaults to `main`, but the CLI must support configurable branch names for repositories that use another base.
- **Error labels**: Existing script patterns use labeled failure messages. Design should define stable labels for invalid args, cache fetch failure, unsafe destination, clone failure, remote rewrite failure, and checkout failure.

## Effort and Risk

- **Effort**: M (3–7 days). The feature uses familiar Nix, shell, Git, and test patterns but needs careful fixture coverage for Git object behavior.
- **Risk**: Medium. Git primitives are stable, but alternates/dissociation semantics, cache path identity, and concurrent refresh behavior need precise design.

## Design-Phase Recommendations

- Prefer **Option B** as the design baseline while still documenting why Option A and C are rejected or deferred.
- Keep the cache main-only by default using explicit fetch refspecs and `--no-tags`; avoid `--mirror` unless a future requirement adds full-ref caching.
- Use `--reference-if-able` only with `--dissociate` for generated working clones.
- Treat the cache as reconstructable state: safe to delete, never the authoritative remote.
- Add fixture tests before implementation tasks are generated; tests should create a local bare upstream, update main, refresh the cache, create clones, inspect remotes, remove cache, and verify the clone remains usable.

---

## Design Discovery Update

### Summary

- **Feature**: `git-clone-isolation`
- **Discovery Scope**: Extension with integration-focused discovery.
- **Key Findings**:
  - A dedicated CLI plus Home Manager module matches repo conventions better than extending generic Git config.
  - Generated clones should use the bare cache as the local clone source, force a non-local transport, dissociate from alternates, then rewrite `origin` to upstream.
  - A small lock around cache mutation reduces concurrent refresh risk without adding a daemon.

### Research Log

#### Shell and Home Manager integration
- **Context**: The requirements need declarative install/config plus a CLI with operator defaults.
- **Sources Consulted**: `scripts/rtk-opencode-smoke-test.nix`, `home-manager/common/subagent-context-budget.nix`, `home-manager/common/default.nix`, `home-manager/common/zellij.nix`.
- **Findings**:
  - Existing scripts use `writeShellApplication` with explicit runtime inputs.
  - Common feature modules use `programs.<feature>.enable`, package options, and `home.packages` wiring.
  - `~/scratch` is already managed and used by zellij worktree configuration.
- **Implications**: Add `scripts/git-clone-isolation.nix` and `home-manager/common/git-clone-isolation.nix`. The module should install a wrapper that exports defaults and delegates to the base CLI.

#### Git clone/cache behavior
- **Context**: Generated clones must be independent from the cache but cheap to create.
- **Sources Consulted**: Git clone/fetch/remote manuals and local Graphite playbook.
- **Findings**:
  - `--reference-if-able` alone creates alternates; `--dissociate` is needed to stop borrowing.
  - `--mirror` is too broad for a main-only cache.
  - `git remote set-url` is the stable way to rewrite `origin` after cloning from the local cache.
- **Implications**: Cache refresh uses explicit `+refs/heads/<branch>:refs/heads/<branch>` refspecs with `--no-tags`. Clone uses local bare cache as source, `--no-local`, `--reference-if-able`, and `--dissociate`, then rewrites `origin`.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend existing Git config | Put package/defaults directly in common Git config | Few files | Blurs generic Git config with workflow tool | Rejected |
| Dedicated CLI + HM module | New script derivation, common module, tests, flake check | Clear boundary, testable, declarative | More files | Selected |
| CLI now, module later | Add script first and defer module options | Fastest first slice | Fails declarative defaults requirement initially | Rejected |

## Design Decisions

### Decision: dedicated CLI plus Home Manager module
- **Context**: Requirements include both operator commands and declarative defaults.
- **Alternatives Considered**:
  1. Extend common Git config.
  2. Add CLI only.
  3. Add dedicated CLI plus module.
- **Selected Approach**: Add `scripts/git-clone-isolation.nix` and `home-manager/common/git-clone-isolation.nix`.
- **Rationale**: The feature has its own lifecycle, defaults, and validation surface.
- **Trade-offs**: More files, but clearer task boundaries and tests.
- **Follow-up**: Design module defaults and wrapper environment names.

### Decision: clone from cache, then rewrite origin
- **Context**: The user wants cheap local clone creation plus normal upstream remotes.
- **Alternatives Considered**:
  1. Clone from upstream using cache as reference.
  2. Clone from cache and leave origin as cache.
  3. Clone from cache and rewrite origin to upstream.
- **Selected Approach**: Clone from the local bare cache with `--no-local --reference-if-able --dissociate`, then set `origin` to the upstream URL.
- **Rationale**: It minimizes network work during clone creation and satisfies normal upstream workflow expectations.
- **Trade-offs**: Requires explicit remote rewrite and validation.
- **Follow-up**: Tests must prove origin points to upstream and clone works after cache removal.

### Decision: deterministic cache identity
- **Context**: Operators need stable, predictable cache paths that can be found without reverse-engineering a hash.
- **Alternatives Considered**:
  1. Human-readable basename only.
  2. Hash only.
  3. Basename plus short hash of upstream URL and branch.
  4. ghq-style `<forge>/<org>/<repo>` path.
- **Selected Approach**: Use a ghq-style path derived from upstream URL, e.g. `github.com/Shopify/globaldb-yugabyte`.
- **Rationale**: Keeps cache paths stable and discoverable while distinguishing repositories by forge and owner.
- **Trade-offs**: Non-main branches share the same repository cache path and should be treated as explicit operator refreshes.
- **Follow-up**: Tests should cover GitHub URL path mapping.

### Decision: lock cache mutation
- **Context**: Two invocations can refresh the same bare cache concurrently.
- **Alternatives Considered**:
  1. No lock.
  2. Platform-specific `flock`.
  3. Portable lock directory with cleanup trap.
- **Selected Approach**: Use a lock directory under the cache root during cache init/refresh.
- **Rationale**: Avoids daemon complexity and works on macOS without extra dependencies.
- **Trade-offs**: Stale lock recovery needs clear error output.
- **Follow-up**: Design failure labels for lock acquisition and stale lock guidance.

## Risks & Mitigations

- Git alternates dependency — Always pair reference cloning with `--dissociate`; test by removing the cache and running Git commands in the clone.
- Cache collision — Preserve forge and owner path in the cache identity.
- Concurrent refresh — Use a cache-local lock directory and report actionable lock errors.
- Scope creep into Graphite/zellij — Keep no-`gt`, no-worktree, no-zellij-change boundaries explicit in design and tasks.

## References

- Git clone manual — reference and dissociate semantics.
- Git fetch manual — refspec and tag behavior.
- Git remote manual — remote URL rewrite behavior.
- XDG Base Directory Specification — `$XDG_STATE_HOME` semantics.
