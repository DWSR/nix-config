# Requirements Document

## Introduction
The Deskflow Hammerspoon Watchdog restores an absent Deskflow core for either
host role. Problem, approach, and scope decisions live in
`.kiro/specs/deskflow-hammerspoon-watchdog/brief.md`.

## Boundary Context
- **In scope**: optional monitoring, missing-core recovery through Deskflow's
  GUI, client and server role support, lifecycle grace periods, bounded retries,
  operator-visible failure reporting, and personal-server rollout.
- **Out of scope**: detecting an unresponsive but present core, repairing
  orphaned or multiple cores, direct core launch, launchd supervision, network
  connectivity monitoring, and initial Shopify-client rollout.
- **Adjacent expectations**: the existing Deskflow configuration supplies an
  enabled client or server role; the existing Hammerspoon framework supplies a
  running automation environment and requires its own Accessibility grant;
  Deskflow remains responsible for starting and owning its core.

## Requirements

### Requirement 1: Optional role-aware enablement
**Objective:** As the operator, I want to opt each Deskflow host into one watchdog, so that supervision follows the host's declared role without duplicate configuration.

#### Acceptance Criteria
1. The Deskflow Watchdog shall be disabled by default.
2. While the Deskflow Watchdog is disabled, the Deskflow Watchdog shall perform no process observation or recovery.
3. Where the Deskflow Watchdog is enabled, the Deskflow Watchdog shall require Deskflow and Hammerspoon to be enabled for the same user.
4. If the Deskflow Watchdog is enabled without a valid Deskflow role, the host configuration shall fail with an error naming the missing prerequisite.
5. Where the Deskflow Watchdog is enabled, the Deskflow Watchdog shall use the host's declared `client` or `server` role without requiring an independent role declaration.
6. The Deskflow Watchdog shall support both Deskflow roles with the same enablement contract.

### Requirement 2: Safe core-state observation
**Objective:** As the operator, I want the watchdog to distinguish a healthy expected core from absence or ambiguity, so that recovery does not interfere with unrelated processes.

#### Acceptance Criteria
1. While exactly one core belonging to the installed Deskflow application is running in the host's declared role, the Deskflow Watchdog shall take no recovery action.
2. If no expected Deskflow core is observed for the required consecutive observations, the Deskflow Watchdog shall classify the core as absent.
3. If a same-named process does not belong to the installed Deskflow application or does not match the declared role, the Deskflow Watchdog shall not classify it as the expected core.
4. If multiple matching cores or an unexpected ownership state are observed, the Deskflow Watchdog shall classify the state as ambiguous rather than absent.
5. When the operator intentionally stops or quits Deskflow while the Deskflow Watchdog is enabled, the Deskflow Watchdog shall treat the resulting core absence as recoverable.
6. While the expected core remains present, the Deskflow Watchdog shall not use peer reachability or connection state as a recovery signal.

### Requirement 3: Login, sleep, and wake behavior
**Objective:** As the operator, I want lifecycle transitions to avoid false recovery, so that normal login and sleep behavior do not cause restart storms.

#### Acceptance Criteria
1. When the Deskflow Watchdog starts, the Deskflow Watchdog shall wait through an initial grace period before classifying core absence.
2. While the host is sleeping, the Deskflow Watchdog shall suspend core observations and recovery attempts.
3. When the host wakes, the Deskflow Watchdog shall wait through a wake grace period before resuming absence classification.
4. When a lifecycle grace period ends, the Deskflow Watchdog shall resume with a fresh absence-observation sequence.

### Requirement 4: GUI-owned recovery
**Objective:** As the operator, I want a missing core restored through Deskflow's supported desktop controls, so that Deskflow retains ownership of the recovered process.

#### Acceptance Criteria
1. When the Deskflow Watchdog confirms that the expected core is absent, the Deskflow Watchdog shall request the role-appropriate start action through the Deskflow GUI.
2. If the Deskflow GUI is not running when recovery begins, the Deskflow Watchdog shall launch it before requesting the start action.
3. If the Deskflow GUI is running but hidden or inactive when recovery begins, the Deskflow Watchdog shall make its recovery controls available before requesting the start action.
4. While a recovery attempt is in progress, the Deskflow Watchdog shall not begin another recovery attempt.
5. When a recovery request completes, the Deskflow Watchdog shall verify that exactly one expected core appears in the declared role.
6. When recovery temporarily changes the frontmost application, the Deskflow Watchdog shall restore the previously focused application after the attempt completes.
7. The Deskflow Watchdog shall never launch `deskflow-core` directly or request a second core instance.

### Requirement 5: Bounded failure handling and feedback
**Objective:** As the operator, I want failed recovery to stop safely and explain itself, so that a persistent fault does not create process, focus, or notification storms.

#### Acceptance Criteria
1. If Hammerspoon lacks Accessibility permission, the Deskflow Watchdog shall suppress recovery and report the missing permission to the operator.
2. If the Deskflow application identity, expected process identity, or recovery action cannot be verified, the Deskflow Watchdog shall fail closed without launching or terminating a core directly.
3. If the core state is ambiguous, the Deskflow Watchdog shall take no destructive action and shall report the ambiguity to the operator.
4. If a recovery attempt does not restore the expected core, the Deskflow Watchdog shall delay the next attempt using bounded backoff.
5. When failed attempts reach the retry limit within the recovery window, the Deskflow Watchdog shall enter a cooldown period and report the failed recovery episode once.
6. When the cooldown period ends and the core remains absent, the Deskflow Watchdog shall begin a new bounded recovery episode.
7. While the same prerequisite or ambiguous-state failure persists, the Deskflow Watchdog shall not repeat its operator alert on every observation.
8. The Deskflow Watchdog shall document that Hammerspoon and Deskflow require separate Accessibility grants for recovery to succeed.

### Requirement 6: Initial host rollout
**Objective:** As the operator, I want the watchdog applied first where crashes are observed, so that the initial rollout limits operational risk.

#### Acceptance Criteria
1. When the personal host configuration is evaluated, the Deskflow Watchdog shall be enabled for its server role.
2. When the Shopify host configuration is evaluated, the Deskflow Watchdog shall remain disabled for its client role.
3. Where a client host explicitly enables the Deskflow Watchdog, the same monitoring, lifecycle, recovery, and failure-handling requirements shall apply in the client role.
4. When either nix-darwin host is evaluated, the host configuration shall complete without role or module conflicts.

### Requirement 7: Verification
**Objective:** As a reviewer, I want automated and host-level evidence of watchdog behavior, so that recovery and safety regressions are caught before broad rollout.

#### Acceptance Criteria
1. The configuration checks shall verify enabled server, enabled client, and disabled watchdog fixtures.
2. The configuration checks shall verify absence debouncing, single-flight recovery, successful recovery, failed-attempt backoff, cooldown, and sleep/wake state transitions without requiring a live Deskflow crash.
3. The configuration checks shall verify that same-named unrelated processes, multiple cores, and unexpected roles do not trigger direct or destructive recovery.
4. The configuration checks shall verify that the contributed Hammerspoon configuration is syntactically valid Lua and references existing Hammerspoon APIs.
5. The configuration checks shall verify personal-server enablement and Shopify-client disablement.
6. When the expected core is terminated during personal-host verification, the Deskflow Watchdog shall restore exactly one server-role core without operator recovery action.
7. If the recovery GUI action is unavailable during host verification, the Deskflow Watchdog shall preserve process state and emit one actionable failure report.
