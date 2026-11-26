# Requirements Document

## Introduction

This specification defines the compatibility and verification contract for scoped repository flakes. See [brief.md](brief.md) for the request and scope.

## Boundary Context

Independent area checks do not certify a deployed host. CI and operators still verify host composition separately. No area check requires a secret value, a live service account, or a switched host.

## Requirements

### Requirement 1: Compatible Nix engine cutover

**Objective:** As the personal Mac operator, I want the flake split to work on the system's Nix installation without losing access to the existing store or build services.

#### Acceptance Criteria
1. When the engine slice is prepared, the personal host configuration shall select an exact, reproducible package of the latest official stable stock Nix release at that time.
2. When that generation is activated, the operator shall be able to verify that the client and running daemon report the selected stock release and can read the existing store.
3. The engine slice shall retain the host's existing trust, substituters, build-user, sandbox, and builder settings. It shall not change the engine package on other hosts.
4. When a slice introduces a lock shape that the old engine cannot read, the rollout shall require a recovery rehearsal and successful locked evaluation on the personal host, CI, and the builder, guest, and sandbox clients before that slice lands.
5. If activation or recovery verification cannot be completed, the rollout shall stop before landing that lock shape. Activation and recovery shall remain operator-owned.

### Requirement 2: Independently addressable areas

**Objective:** As a contributor or agent, I want to select one area's tests without running the repository-wide suite.

#### Acceptance Criteria
1. When a contributor selects an area from a checkout, the repository shall expose its checks through an independent flake under `flakes/<area>/`.
2. When a supported system runs an area's checks, the area shall exercise its own implementation without evaluating unrelated area checks or a root host configuration.
3. When an area adds a local check, the repository shall make it available through the area's ordinary check command without an edit to root check wiring.
4. The area flake shall resolve code and data from its own tree or declared dependencies, with no dependency on the root flake.
5. If an area does not support a build system, the repository shall document the supported systems and shall not report that area's checks as passed on the unsupported system.

### Requirement 3: Root compatibility

**Objective:** As an operator or downstream consumer, I want existing commands and configurations to keep working during the migration.

#### Acceptance Criteria
1. When a migration slice lands, the repository shall retain the baseline root host, check, app, package, formatter, overlay, library, and default dev-shell selectors on their existing systems, as well as the personal host's existing registry and search-path aliases.
2. When an existing selector resolves, the repository shall preserve its behavior and source pins except for the personal-host engine change in Requirement 1. Published build outputs shall use the same production configuration and package provenance as before the move.
3. When a root check aliases an area check, both shall select the same derivation in the root's pin context.
4. If two owners claim the same root selector, root evaluation shall fail with the selector and both owners, rather than silently choose one.
5. The repository shall retain encrypted secret files, runtime paths, ownership, modes, and consumer bindings without exposing secret values in tests or build inputs.

### Requirement 4: Coverage and integration

**Objective:** As a reviewer, I want the same regressions to be caught after a move as before it.

#### Acceptance Criteria
1. When an existing check moves or is split, the repository shall preserve its assertions and platform gates and retain its original root selector.
2. When a check asserts production wiring, the check shall continue to consume the actual deployed host declaration, not a standalone area fixture.
3. When an area tests a reusable module, the area shall use a local fixture and shall not require a deployment, live credentials, or a real host identity.
4. If a verification command cannot run on the available platform or builder, the verification record shall name the command and blocker without reporting a pass. Existing special runner and evaluation-only gates shall remain covered.
5. When the Fabro sandbox runs the locked evaluation commands supported before the split, its prewarmed sources shall cover both direct and transitive dependencies of those commands.

### Requirement 5: Reproducible dependencies

**Objective:** As a lockfile maintainer, I want scoped and aggregate test signals to use the intended dependency versions.

#### Acceptance Criteria
1. When the root or an area is evaluated without lock updates, it shall resolve its recorded external dependency identities from a clean checkout on the supported Nix engine.
2. When the root and an area share a dependency pin, the repository shall detect disagreement between the standalone and composed identities. The diagnostic shall name the owner and dependency.
3. When a local source-only edit is evaluated in a tracked checkout, the affected flake shall see that edit without an external dependency bump or lockfile rewrite.
4. When manifests or lockfiles move, automated dependency updates and release-age policy shall still cover them. Purposefully distinct pins shall remain distinct.

### Requirement 6: Parallel validation and maintainability

**Objective:** As a maintainer, I want agents and CI workers to validate independent scopes with consistent commands and as little shared editing as possible.

#### Acceptance Criteria
1. When CI runs area checks, the pipeline shall dispatch independent scopes to compatible runners, identify the failing scope, and preserve the required root integration signal.
2. When an agent receives an area-scoped task, the contributor guide and workflow boundary rules shall let it select the area's validation and change area-owned wiring without claiming unrelated root files.
3. The repository shall document each area's ownership, local test command, shared-input update path, and applicable integration checks.
4. When the migration is complete, root `flake.nix` shall be at most 1,000 lines and shall not contain inline test suites.
5. When a slice is reviewed, the migration shall compare its output coverage, affected checks, and authoritative pins against its baseline and observe the repository's diff limits.
