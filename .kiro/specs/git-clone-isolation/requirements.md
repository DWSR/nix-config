# Requirements Document

## Introduction

`git-clone-isolation` provides fast, isolated Git working clones for Graphite-managed repositories where worktrees share `.git` metadata. See `brief.md` for the problem statement, chosen approach, and scope decisions.

## Boundary Context

- **In scope**: Maintaining a reconstructable bare base-branch cache, creating isolated working clones, setting generated clone remotes to the original upstream, and installing/configuring the CLI through Nix/Home Manager.
- **Out of scope**: Replacing Graphite, wrapping `gt`, repairing Graphite metadata, managing Git worktrees, changing `zellij-worktree`, mirroring every branch/tag, running background refresh daemons, or synchronizing uncommitted work between clones.
- **Adjacent expectations**: Existing Git configuration, hooks, `~/scratch`, and zellij workflows remain usable. Graphite state isolation is achieved by creating separate clones, not by changing Graphite behavior.

## Requirements

### Requirement 1: Cache lifecycle
**Objective:** As an operator, I want a local repository cache that tracks the upstream base branch, so that creating isolated clones does not require a full network clone each time.

#### Acceptance Criteria
1. When the operator initializes a cache for an upstream repository, the Git Clone Isolation Tool shall create or update a reconstructable cache for the configured base branch.
2. When the operator refreshes an existing cache, the Git Clone Isolation Tool shall update the cached base branch from the original upstream repository.
3. The Git Clone Isolation Tool shall maintain the cache as a bare repository without a working tree.
4. The Git Clone Isolation Tool shall store cache state under a configurable state root that defaults to `$XDG_STATE_HOME/git-clone-isolation`.
5. The Git Clone Isolation Tool shall avoid storing unrequested branches and tags in the default cache.
6. If the upstream repository or configured base branch cannot be reached, the Git Clone Isolation Tool shall report an actionable error without deleting a previously usable cache.

### Requirement 2: Isolated working clone creation
**Objective:** As an operator, I want each workspace to be a complete clone with its own Git metadata, so that Graphite state cannot leak across workspaces.

#### Acceptance Criteria
1. When the operator requests an isolated clone from a cached repository, the Git Clone Isolation Tool shall create a working clone at the requested destination or under the configured clone root.
2. The Git Clone Isolation Tool shall default the clone root to `~/scratch`.
3. The generated clone shall have its own `.git` directory that is not shared with the cache or with any other generated clone.
4. The generated clone shall contain the objects it needs without relying on the cache after clone creation.
5. If the target destination already contains unrelated files, the Git Clone Isolation Tool shall stop with an error instead of overwriting them.

### Requirement 3: Upstream remote and branch state
**Objective:** As an operator, I want generated clones to behave like normal upstream clones, so that existing Git and Graphite workflows work without cache-specific remotes.

#### Acceptance Criteria
1. When the Git Clone Isolation Tool creates a working clone, the generated clone's `origin` remote shall point to the original upstream repository.
2. When the Git Clone Isolation Tool creates a working clone from a local cache, the generated clone shall not leave `origin` pointing at the local cache.
3. When the operator requests a base branch, the generated clone shall check out that branch when it is available from the upstream cache.
4. The generated clone shall be usable with normal Git commands without requiring the cache path to remain present.
5. If remote rewriting or branch checkout fails, the Git Clone Isolation Tool shall report the failing step and destination path.

### Requirement 4: Declarative installation and configuration
**Objective:** As a nix-config maintainer, I want the tool installed and configured declaratively, so that both hosts receive consistent behavior.

#### Acceptance Criteria
1. Where the Home Manager module is enabled, the system shall install the Git Clone Isolation Tool on the user's PATH.
2. The system shall provide configurable defaults for cache root, clone root, and base branch.
3. The system shall derive default paths from the user's environment or Home Manager configuration rather than hardcoded machine-specific paths.
4. Where the Home Manager module is disabled, the system shall not add the Git Clone Isolation Tool to the user's PATH through that module.
5. When the operator asks for help or version information, the Git Clone Isolation Tool shall return that information without requiring an existing cache or network access.

### Requirement 5: Graphite and adjacent workflow boundaries
**Objective:** As an operator, I want the tool to avoid changing adjacent workflows, so that it solves isolation without taking ownership of Graphite or worktree behavior.

#### Acceptance Criteria
1. The Git Clone Isolation Tool shall not run Graphite commands as part of cache refresh or clone creation.
2. The Git Clone Isolation Tool shall not modify `.git/.graphite_*` files in existing repositories.
3. The Git Clone Isolation Tool shall not create or manage Git worktrees.
4. The Git Clone Isolation Tool shall not change `zellij-worktree` configuration or behavior.
5. The Git Clone Isolation Tool shall not synchronize uncommitted work between isolated clones.

### Requirement 6: Verification without network dependencies
**Objective:** As a maintainer, I want repeatable local validation, so that the tool's Git behavior can be tested without contacting real upstream repositories.

#### Acceptance Criteria
1. When the validation suite runs, the system shall use local fixture repositories instead of network upstreams.
2. The validation suite shall verify cache creation or refresh for a configured base branch.
3. The validation suite shall verify generated clone remote configuration points to the fixture upstream rather than the cache.
4. The validation suite shall verify generated clones have independent `.git` metadata.
5. The validation suite shall verify generated clones remain usable after the cache path is unavailable.
