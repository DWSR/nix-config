# Implementation Plan

- [ ] 1. Establish the CLI package and command contract
- [x] 1.1 Create the packaged command skeleton
  - Add a packaged operator command with `refresh`, `clone`, `--help`, and `--version` routing.
  - Add argument validation and stable failure-label output for invalid commands before any cache or network access.
  - Completed state: the built command prints help/version in a clean environment and rejects an unknown subcommand with `invalid_arguments`.
  - _Requirements: 4.5_
  - _Boundary: CLI, ErrorReporter_

- [x] 1.2 Expose the command as a flake app and package contract check
  - Add a flake app so the command can be invoked through `nix run`.
  - Add a cheap package check that exercises help and version behavior without cache state.
  - Completed state: the app resolves to the packaged command and the help/version check passes in the flake checks.
  - _Requirements: 4.5_
  - _Depends: 1.1_
  - _Boundary: CLI, TestHarness_

- [ ] 2. Implement cache and clone runtime behavior
- [x] 2.1 Resolve operator defaults and cache identity
  - Require repository URL from command input while resolving cache root, clone root, base branch, and destination from flags, wrapper environment, and built-in fallbacks.
  - Derive a deterministic cache path from repository identity and branch without hardcoded machine-specific paths.
  - Completed state: local checks demonstrate flag values override wrapper defaults and fallback values, missing repository URL fails validation, and two same-basename repositories produce distinct cache paths.
  - _Requirements: 1.4, 2.2, 4.2, 4.3_
  - _Boundary: ConfigResolver_

- [x] 2.2 Implement the bare cache lifecycle
  - Create or refresh a bare cache for the configured branch using a base-branch-only fetch.
  - Keep unrequested branches and tags out of the default cache.
  - Add cache-local locking so concurrent refresh attempts cannot mutate the same bare cache simultaneously.
  - Preserve the previous usable cache when refresh fails.
  - Completed state: a local fixture refresh produces a bare repository without a working tree, contains the configured branch, and leaves an existing cache usable after a simulated failed refresh.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
  - _Boundary: CacheManager_

- [x] 2.3 Implement isolated clone creation
  - Ensure the bare cache exists and is refreshed before clone creation begins.
  - Refuse non-empty or unsafe destinations before clone work begins.
  - Create a working clone from the bare cache with clone acceleration and no persistent cache dependency.
  - Rewrite `origin` to the original upstream repository and check out the requested base branch.
  - Report remote rewrite and checkout failures with `remote_rewrite_failed` or `checkout_failed`, including the failing step and destination path.
  - Preserve the boundary that the command does not run Graphite, create worktrees, edit Graphite metadata, modify zellij, or synchronize uncommitted work.
  - Completed state: clone from a missing or stale cache refreshes first, the generated clone has its own `.git` directory, `origin` points to upstream, the requested branch is checked out, remote/checkout failure simulations report step and destination, and the clone remains usable after the cache is unavailable.
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Depends: 2.1, 2.2_
  - _Boundary: CloneManager, ErrorReporter_

- [ ] 3. Add declarative Home Manager integration
- [x] 3.1 Create the common Home Manager module
  - Add an enable gate, package option, cache root, clone root, and default branch options.
  - Install a wrapper that supplies configured defaults to the packaged command.
  - Completed state: enabling the module adds the command to `home.packages` and exposes configured defaults through the wrapper.
  - _Requirements: 4.1, 4.2, 4.3_
  - _Boundary: HMModule_

- [x] 3.2 Wire the module into the common host configuration
  - Import the module in the common Home Manager module list.
  - Enable the module for the common host configuration without changing existing Git or zellij behavior.
  - Completed state: both nix-darwin host configurations evaluate with the module enabled and no hardcoded user path is introduced.
  - _Requirements: 4.1, 4.3, 4.4, 5.4_
  - _Depends: 3.1_
  - _Boundary: HMModule_

- [ ] 4. Add network-free validation
- [x] 4.1 Create the test harness scaffold
  - Add the test package structure and shared fixture helpers for local Git upstreams and temporary home/state roots.
  - Add helper behavior for building or locating the packaged command under test.
  - Completed state: `node --test tests/git-clone-isolation/` discovers the suite and the fixture helper can create a local repository with a main branch.
  - _Requirements: 6.1_
  - _Boundary: TestHarness_

- [x] 4.2 Add cache lifecycle integration tests
  - Cover cache creation, cache refresh, bare-cache invariant, main-only cache behavior, and failed-refresh preservation.
  - Cover cache lock behavior enough to prove concurrent refreshes cannot mutate the same cache simultaneously.
  - Completed state: the cache lifecycle tests pass against local fixture repositories without network access.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.2_
  - _Depends: 2.1, 2.2, 4.1_
  - _Boundary: TestHarness, CacheManager_

- [ ] 4.3 Add clone behavior integration tests
  - Cover clone-triggered cache refresh when the cache is missing or stale.
  - Cover clone creation, origin rewrite, branch checkout, independent `.git` metadata, no persistent alternates, and cache-removal usability.
  - Cover unsafe destination rejection, remote rewrite failure reporting, checkout failure reporting, and boundary regressions for no Graphite/worktree/zellij ownership.
  - Completed state: the clone behavior tests pass against local fixture repositories without network access and assert failure labels include failing step plus destination path.
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.3, 6.4, 6.5_
  - _Depends: 2.1, 2.2, 2.3, 4.1_
  - _Boundary: TestHarness, CloneManager_

- [ ] 4.4 Add Home Manager render tests
  - Verify both host configurations render the package and default option values when enabled.
  - Verify disabling the module omits the package from `home.packages`.
  - Completed state: the Home Manager render test passes and proves module defaults for cache root, clone root, and base branch.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.4, 6.1_
  - _Depends: 3.1, 4.1_
  - _Boundary: TestHarness, HMModule_

- [ ] 4.5 Wire validation into flake checks
  - Add a flake check that runs the git-clone-isolation test suite in an isolated temporary home.
  - Add any required runtime inputs for local Git fixture tests.
  - Completed state: the flake exposes a `git-clone-isolation` check that runs the behavior and render tests.
  - _Requirements: 4.5, 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Depends: 4.2, 4.3, 4.4_
  - _Boundary: TestHarness_

- [ ] 5. Validate the complete feature
  - Run formatting and the targeted test suite.
  - Evaluate the affected host configurations or flake checks that cover the new module.
  - Completed state: targeted validation passes and no fixture cache or clone state remains in the working tree.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Depends: 4.5_
  - _Boundary: CLI, HMModule, TestHarness_
