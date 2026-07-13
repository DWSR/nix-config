# Implementation Plan

> Task 5.5 is operator-gated because it intentionally stops and terminates the
> active Deskflow core. Autonomous implementation must request confirmation
> before running that task.

- [ ] 1. Establish process-snapshot and test foundations
- [x] 1.1 Build and package the kernel-backed process inventory
  - Implement a Darwin helper that enumerates current-user processes whose kernel name is exactly `deskflow-core` and reports PID, parent PID, and kernel-derived executable path.
  - Skip only candidates that disappear during enumeration, fail without partial output on other inspection errors, sort by PID, and return successful empty output for no matches.
  - Package the helper as the immutable command consumed by later configuration.
  - Completion is observable when the helper derivation builds and repeated no-match invocations return deterministic empty output with exit zero.
  - _Requirements: 2.1, 2.3, 2.4_
  - _Boundary: Snapshot Helper_

- [x] 1.2 Complete role extraction, encoding, and helper tests
  - Read argv through `KERN_PROCARGS2`, extract the first positional role, and emit the approved percent-encoded tab-separated contract.
  - Cover encoding, argv parsing, sorting, disappearance handling, and no-partial-output errors with C tests.
  - Completion is observable when helper tests pass and every emitted record decodes to PID, parent PID, absolute path, and role.
  - _Requirements: 2.1, 2.3, 2.4, 7.3_
  - _Boundary: Snapshot Helper_

- [x] 1.3 Add deterministic process and menu fixtures
  - Add client/server snapshots plus absent, orphan, wrong-path, wrong-role, duplicate-GUI, and duplicate-core variants.
  - Add localized menu trees with one enabled Command-S start action plus disabled-only and zero/multiple candidate variants.
  - Completion is observable when plain Lua loads every fixture and each fixture names its intended classification or menu outcome.
  - _Requirements: 6.3, 7.1, 7.2, 7.3_
  - _Boundary: Verification_

- [x] 1.4 Build the deterministic fake Hammerspoon harness
  - Provide controllable timers, tasks, applications, menus, lifecycle events, alerts, and focus state.
  - Record every asynchronous callback and external effect without running a GUI or process.
  - Completion is observable when a smoke test can advance time, complete a task, fire lifecycle events, and inspect recorded effects deterministically.
  - _Requirements: 7.2, 7.3_
  - _Boundary: Verification_

- [ ] 2. Implement the pure watchdog model
- [x] 2.1 Parse snapshots and classify GUI/core ownership
  - Decode and validate snapshots without assuming paths contain no spaces.
  - Classify the one expected-path GUI and exact role-matched child core as healthy, valid zero-core states as absent, malformed snapshots as errors, and every ownership/path/cardinality conflict as ambiguous.
  - Completion is observable when model tests pass for both roles and all absent, error, and ambiguity fixtures without recovery decisions for unsafe states.
  - _Depends: 1.2, 1.3_
  - _Requirements: 2.1, 2.3, 2.4, 7.3_
  - _Boundary: Pure Model_

- [x] 2.2 Select the localized GUI start action safely
  - Traverse the menu tree and return a localized path only when exactly one enabled leaf has a case-insensitive `S` shortcut and exactly the Command modifier.
  - Reject zero, disabled-only, and multiple candidates without a fallback selection.
  - Completion is observable when selector tests pass for server, client/localized, unavailable, and ambiguous fixtures.
  - _Depends: 1.3_
  - _Requirements: 4.1, 4.3, 5.2, 7.2, 7.7_
  - _Boundary: Pure Model_

- [x] 2.3 Implement grace, debounce, single-flight, and sleep/wake transitions
  - Implement startup/wake grace, two-observation absence debounce, healthy reset, and single-flight recovery phases.
  - Treat intentional stops as absence, ignore peer/connection state, and reset absence evidence after wake.
  - Transition an active recovery to an aborted state on sleep and emit focus-restoration work for the runtime shell.
  - Completion is observable when deterministic tests pass for login, healthy, intentional stop, overlapping polls, interrupted recovery, and wake flows.
  - _Depends: 1.3_
  - _Requirements: 2.2, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 4.4, 7.2_
  - _Boundary: Pure Model_

- [x] 2.4 Implement retry, cooldown, and alert-key policy
  - Implement the rolling attempt window, approved retry delays, attempt limit, cooldown restart, and persistent-reason alert deduplication.
  - Clear retry/cooldown and stale alert keys after a healthy observation.
  - Completion is observable when deterministic tests pass for successful recovery, repeated failures, cooldown re-entry, rolling-window expiry, and alert reset.
  - _Requirements: 5.4, 5.5, 5.6, 5.7, 7.2_
  - _Boundary: Pure Model_

- [ ] 3. Implement the Hammerspoon runtime shell
- [x] 3.1 Connect asynchronous observation and lifecycle control
  - Retain poll, delayed, lifecycle-watcher, and task handles; invoke only the rendered snapshot-helper command.
  - Collect all matching GUI PID/path records, prevent overlapping observations, and pass complete inventories to the model.
  - Suspend on sleep, invalidate callback epochs, and ignore stale callbacks after epoch changes or reload.
  - Completion is observable when fake-runtime smoke cases show polling, lifecycle suspension/grace, full GUI cardinality, and no recovery for healthy, ambiguous, or inventory-error observations.
  - _Depends: 1.2, 1.4, 2.1, 2.3_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 3.1, 3.2, 3.3, 3.4, 4.4, 5.2, 5.3_
  - _Boundary: Runtime Shell_

- [x] 3.2 Launch, surface, and activate the Deskflow GUI
  - Validate the exact cask path and bundle ID, save prior focus, and launch an absent GUI through LaunchServices.
  - Surface a hidden GUI through its duplicate-instance path, reacquire one expected-path instance, and poll frontmost state with the approved interval and timeout.
  - Re-observe after launch and stop before menu work if GUI autostart already restored the core.
  - Completion is observable when fake-runtime cases cover absent, hidden, delayed activation, activation timeout, wrong-path, and duplicate GUI states without arbitrary instance selection.
  - _Depends: 2.1, 2.3, 3.1_
  - _Requirements: 4.2, 4.3, 4.4, 5.2, 5.3_
  - _Boundary: Runtime Shell_

- [x] 3.3 Select the start action, verify recovery, and restore focus
  - Enumerate menus asynchronously only after activation and select only the model-approved localized path.
  - Verify one exact GUI-owned core in the declared role before completing recovery.
  - Restore prior focus on success, menu/verification failure, activation timeout, and sleep abort; retry one pending restoration before wake grace.
  - Never invoke the core binary, `--new-instance`, app kill APIs, or task termination as recovery.
  - Completion is observable when fake-runtime cases recover each role once, reject unavailable/multiple menu actions, restore focus, and record no prohibited effect.
  - _Depends: 2.2, 2.4, 3.2_
  - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6, 4.7, 5.2, 7.2, 7.3, 7.7_
  - _Boundary: Runtime Shell_

- [x] 3.4 Add fail-closed reporting and bounded retry orchestration
  - Suppress recovery and report once when Hammerspoon Accessibility is unavailable.
  - Map bundle, helper, activation, menu, selection, verification, and ambiguity failures to stable alert reasons while honoring model backoff/cooldown decisions.
  - Completion is observable when persistent failures alert once per reason, cooldown suppresses effects, and recovery resumes only after model eligibility returns.
  - _Depends: 2.4, 3.3_
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_
  - _Boundary: Runtime Shell_

- [ ] 4. Integrate configuration and host rollout
- [x] 4.1 Render the scoped role-aware Lua contribution
  - Inject the validated Deskflow role and immutable snapshot-helper path into one local scope containing standalone model/runtime modules and one runtime start call.
  - Keep serialization limited to the role enum and Nix store path.
  - Completion is observable when isolated client/server renders are valid Lua and differ only by role.
  - _Depends: 1.2, 2.1, 2.2, 2.3, 2.4, 3.4_
  - _Requirements: 1.5, 1.6, 6.3, 7.1, 7.4_
  - _Boundary: Renderer_

- [x] 4.2 Define and connect the optional watchdog module
  - Expose one disabled-by-default flag, document both Accessibility grants, and assert enabled Hammerspoon, enabled Deskflow, and a valid shared role.
  - Reference the existing snapshot-helper package, pass its path and the shared role to the renderer, and expose no role or command override.
  - Contribute no watchdog Lua while disabled.
  - Completion is observable when direct Home Manager evaluations show the disabled default, a rendered enabled contribution, and named prerequisite failures.
  - _Depends: 4.1_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 5.8_
  - _Boundary: Watchdog Module_

- [x] 4.3 Wire the module and personal-only rollout
  - Import the optional feature through the shared Home Manager module set.
  - Enable it beside the personal server and leave the Shopify client disabled by default.
  - Preserve both host role declarations and existing Deskflow/Hammerspoon renderers.
  - Completion is observable when both host configurations evaluate with personal enabled/server and Shopify disabled/client states.
  - _Depends: 4.2_
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: Host Integration, Watchdog Module_

- [ ] 5. Validate build, wiring, and runtime behavior
- [x] 5.1 Register helper and pure-model checks
  - Run the C helper tests and plain-Lua snapshot, classifier, menu-selector, lifecycle, and retry suites in the feature check.
  - Completion is observable when the targeted helper/model derivation succeeds and injected malformed/ambiguous fixtures fail only their expected assertions.
  - _Depends: 1.2, 2.4_
  - _Requirements: 7.1, 7.2, 7.3_
  - _Boundary: Verification_

- [x] 5.2 Register runtime-shell checks
  - Run fake-Hammerspoon suites for observation, activation, menu selection, verification, focus restoration, interrupted recovery, alerts, and prohibited-effect absence.
  - Completion is observable when the runtime derivation succeeds without a running GUI, Accessibility grants, or host process mutation.
  - _Depends: 1.4, 3.4_
  - _Requirements: 7.2, 7.3, 7.7_
  - _Boundary: Verification_

- [ ] 5.3 Register render, prerequisite, syntax, and semantic checks
  - Add client/server/disabled render assertions and enabled-with-missing-prerequisite evaluation failures.
  - Run the existing Hammerspoon syntax and semantic gate over an isolated server contribution.
  - Completion is observable when targeted render/semantic derivations succeed and an injected nonexistent Hammerspoon API is rejected.
  - _Depends: 4.2_
  - _Requirements: 1.1, 1.3, 1.4, 1.6, 7.1, 7.4_
  - _Boundary: Verification_

- [ ] 5.4 Add both-host rollout assertions
  - Assert one personal server-role watchdog contribution with an immutable helper path and no Shopify watchdog sentinel.
  - Confirm the disabled Shopify client retains compatibility with explicit future enablement.
  - Completion is observable when the host-wiring check reports both hosts' enablement, inherited role, and rendered contribution state.
  - _Depends: 4.3_
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.5_
  - _Boundary: Verification_

- [ ] 5.5 Run the operator-gated personal-server recovery drill
  - Confirm both Accessibility grants and capture live helper and stopped/hidden menu metadata before disruption; update fixtures only within approved contracts.
  - With another app focused, stop the core through Deskflow and separately terminate the observed core to simulate a crash.
  - Verify each case restores exactly one GUI-owned server core within the policy window and restores focus without direct/destructive fallback.
  - If the GUI action is naturally unavailable, verify one alert and unchanged process state; deterministic unavailable coverage remains mandatory.
  - Completion is observable when the drill records path, parent, role, timing, focus, and alert evidence and all automated checks still pass.
  - If live GUI ownership or restart semantics differ from the design, stop and report the named revalidation trigger rather than changing the boundary.
  - _Depends: 5.1, 5.2, 5.3, 5.4_
  - _Requirements: 2.5, 4.1, 4.3, 4.5, 4.6, 4.7, 5.2, 5.3, 7.6, 7.7_
  - _Boundary: Verification_

## Implementation Notes

- Hammerspoon menu trees include anonymous dense wrappers under `AXChildren[1]`; traverse them without adding localized path segments.
- Runtime adapters must use `Model.advanceRecovery` for ordered `activating` -> `selecting` -> `verifying` transitions instead of mutating model state.
- Wake grace and retry/cooldown eligibility are separate model deadlines; runtime scheduling must not collapse one into the other.
- Epoch-stale runtime callbacks may release retained handles only; they must not emit model or external effects.
- Post-activation work must reacquire the same expected-path GUI PID; saved application handles cannot authorize menu or verification effects.
- Async callbacks must be consumed before effects; thrown, repeated, or reentrant callbacks must not duplicate selection, model results, or focus restoration.
- Nix equality ignores string context while `builtins.toJSON` preserves it; canonicalize validated role enums before serialization and lexically pin the helper dependency.
