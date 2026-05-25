# Implementation Plan

- [ ] 1. Establish timestamp verification foundation
- [x] 1.1 Create patch contract tests for the timestamp boundary
  - Add a Node test suite that inspects the planned timestamp patch as the source of truth for boundary and behavior checks.
  - Verify the patch is limited to the live TUI session route and does not target session schemas, plugin files, tool execution, cavemem, Obsidian, RTK, cost-diagnosis, or mcpproxy paths.
  - Verify the patch contract expects a visible timestamp default, user turn timestamp rendering, assistant turn timestamp rendering, assistant creation-time usage, and message-text preservation.
  - Verify formatter semantics in the patched source: existing local-time formatter usage, one consistent formatter for user and assistant turns, cross-day-capable formatter usage, and fallback behavior when creation metadata is absent.
  - Verify non-user and non-assistant transcript elements do not receive turn timestamp rendering.
  - The task is done when the suite fails with specific labels if the patch file is missing or violates any timestamp boundary, formatter, or role-limiting rule.
  - _Requirements: 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4_
  - _Boundary: PatchBoundaryGuard, TimestampVerificationSuite_

- [x] 1.2 Wire the timestamp contract tests into the repo check graph
  - Add a flake check that runs the timestamp contract suite with the existing Node test pattern.
  - Keep the check isolated from host-specific state so it can run before a host rebuild.
  - The task is done when the repo exposes a timestamp test check that fails before the implementation patch satisfies the contract.
  - _Requirements: 4.4, 6.1, 6.2, 6.3, 6.4, 6.5_
  - _Boundary: TimestampVerificationSuite_

- [ ] 2. Patch the live OpenCode TUI timestamp behavior
- [x] 2.1 Add the feature-owned timestamp visibility default
  - Add the timestamp patch scaffold against the existing OpenCode live session route.
  - Make the effective timestamp state default to visible for this feature while preserving the existing `/timestamps` and `/toggle-timestamps` operator controls.
  - Keep the state local to OpenCode TUI visibility and out of session history.
  - The task is done when the contract test detects the feature-owned visible default and the toggle surface remains present in the patched source.
  - _Requirements: 1.1, 1.2, 4.1, 5.6_
  - _Boundary: TimestampVisibilityPolicy_

- [x] 2.2 Preserve and complete user turn timestamp rendering
  - Keep user turn timestamps based on the existing creation-time metadata and formatter.
  - Ensure queued user turns do not replace the timestamp with the queued badge when timestamps are visible.
  - Keep timestamp metadata separate from user message text.
  - Preserve formatter behavior for local time, consistent format, cross-day distinction, and missing creation-time fallback.
  - The task is done when user timestamp checks pass and the patched source still renders the original user text path unchanged.
  - _Requirements: 1.1, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.4, 3.5, 5.6, 6.1_
  - _Boundary: UserTurnTimestampRenderer, TurnTimestampFormatter_

- [x] 2.3 Add assistant turn timestamp rendering
  - Render assistant turn timestamps from creation-time metadata whenever timestamps are visible, including while completion time is absent.
  - Preserve existing assistant mode, model, duration, and interrupted metadata behavior.
  - Keep assistant timestamp metadata separate from assistant message text and tool inputs.
  - Use the same local-time formatter and missing-metadata fallback behavior as user timestamps.
  - The task is done when assistant timestamp checks pass for creation-time usage and no check relies on assistant completion time.
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 5.6, 6.2, 6.3_
  - _Boundary: AssistantTurnTimestampRenderer, TurnTimestampFormatter_

- [ ] 3. Integrate the timestamp patch with the pinned OpenCode package
- [x] 3.1 Wire the timestamp patch into the pinned OpenCode overlay
  - Add the timestamp patch to the existing pinned OpenCode build without changing prompt replacement behavior.
  - Avoid dependency changes; the patched behavior must use existing OpenCode timestamp and formatting utilities.
  - Include a nearby restart note so future operators know a host rebuild plus fresh OpenCode process is required before behavior changes appear.
  - The task is done when the pinned package applies the timestamp patch during build and still preserves the existing prompt patch pipeline.
  - _Depends: 2.1, 2.2, 2.3_
  - _Requirements: 4.1, 4.2, 4.3, 4.5, 6.5_
  - _Boundary: OverlayPatchApplicator_

- [x] 3.2 Add the OpenCode package build canary
  - Add a flake check that forces the patched pinned OpenCode package to build.
  - Ensure OpenCode source drift fails during verification before timestamp support is reported as available.
  - The task is done when the package canary is part of the repo check graph and fails if the patch no longer applies.
  - _Depends: 3.1_
  - _Requirements: 4.4, 6.5_
  - _Boundary: OverlayPatchApplicator, TimestampVerificationSuite_

- [x] 3.3 Verify both configured hosts consume the patched package
  - Add or extend a host evaluation check that confirms both configured nix-darwin hosts resolve OpenCode through the shared patched package path.
  - Keep the check declarative and independent of a switched host.
  - The task is done when verification fails if either configured host stops consuming the patched OpenCode package.
  - _Depends: 3.1_
  - _Requirements: 4.1, 4.2, 4.4_
  - _Boundary: OverlayPatchApplicator, TimestampVerificationSuite_

- [ ] 4. Validate end-to-end timestamp behavior and boundaries
- [ ] 4.1 Run and repair the timestamp verification suite
  - Run the timestamp contract tests and fix any gaps between the patch and the design contract.
  - Confirm user timestamps, assistant timestamps, streaming-stable creation-time behavior, formatter semantics, role limiting, visible default, and boundary guards all pass together.
  - The task is done when the timestamp contract check exits successfully from the repo flake check.
  - _Depends: 1.2, 2.1, 2.2, 2.3, 3.1_
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4_
  - _Boundary: PatchBoundaryGuard, TimestampVerificationSuite_

- [ ] 4.2 Run the patched package and smoke validation path
  - Run the patched package build canary and host-consumption check and fix build, patch application, or host evaluation failures.
  - Perform a short local OpenCode smoke run after rebuild or direct package use to confirm user and assistant turns visibly show timestamps and `/timestamps` still toggles the display.
  - Confirm the smoke path does not require runtime network access or a separate installer.
  - The task is done when the build canary passes, both host checks pass, and the smoke run demonstrates visible user and assistant timestamps in a fresh OpenCode process.
  - _Depends: 3.2, 3.3, 4.1_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 4.5, 5.6, 6.5_
  - _Boundary: OverlayPatchApplicator, TimestampVerificationSuite_
