# Implementation Plan

- [ ] 1. Establish RTK package and Home Manager foundation
- [x] 1.1 Package RTK from the intended upstream source
  - Add a reproducible RTK package built from the pinned `rtk-ai/rtk` source rather than crates.io name resolution.
  - Expose the `rtk` binary and version/source identity so the operator and smoke tests can inspect it.
  - Ensure the package build fails on source or cargo hash drift before any OpenCode integration can be enabled.
  - Completed state: both target host package sets can build a `rtk` package whose binary reports the pinned version.
  - _Requirements: 1.1, 1.4, 4.1, 4.2, 4.3, 4.4, 5.1_
  - _Boundary: RTK Package_

- [x] 1.2 Add the RTK smoke-test package scaffold
  - Create the runtime verifier package entrypoint and failure-label conventions before the Home Manager module references it.
  - Include initial checks for command availability and metadata path inputs, with deeper RTK-specific checks added after integration is wired.
  - Completed state: the smoke-test package builds and can emit a named failure for a missing required input without depending on the final module.
  - _Depends: 1.1_
  - _Requirements: 1.2, 4.4, 7.1_
  - _Boundary: Smoke and Tests_

- [x] 1.3 Add the RTK Home Manager module scaffold
  - Define the OpenCode RTK module with host default state, package exposure, metadata path, usage-tag contract, and smoke-test package option.
  - Add the OpenCode dependency assertion so evaluation fails with an actionable message if OpenCode is disabled.
  - Import and enable the module from the common Home Manager configuration so both target hosts receive the integration surface.
  - Completed state: evaluating either host renders the RTK module options and fails predictably if the OpenCode dependency is removed.
  - _Depends: 1.2_
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 3.4, 7.5_
  - _Boundary: RTK Module_

- [ ] 2. Implement runtime state and operator visibility
- [x] 2.1 Resolve effective RTK state in the OpenCode wrapper
  - Add wrapper-time resolution of the host default plus the `OPENCODE_RTK` per-launch override.
  - Export the effective RTK state, Shopify usage-tag value, telemetry-disable value, and disable reason before OpenCode starts.
  - Reject invalid override values with an actionable startup error and force safe disabled state when telemetry cannot be made explicit.
  - Completed state: launching OpenCode with unset, enabled, disabled, and invalid override values produces the documented effective state or startup error.
  - _Depends: 1.3_
  - _Requirements: 3.2, 3.5, 3.6, 3.7, 5.2, 5.3, 6.2, 6.6, 7.1_
  - _Boundary: State Resolver, RTK Module_

- [x] 2.2 Render RTK metadata and operator guidance
  - Render local metadata that records package identity, source identity, default state, env names, telemetry env, and plugin path.
  - Add operator-facing guidance for restart behavior, host defaults, per-launch overrides, rollback, and before/after measurement.
  - Keep generated state and guidance local to the host and repository-managed config.
  - Completed state: the metadata and operator guide are present after Home Manager render and describe the exact env vars and restart action.
  - _Depends: 2.1_
  - _Requirements: 3.1, 3.3, 3.8, 4.2, 4.4, 5.4, 6.2_
  - _Boundary: RTK Module, Metadata_

- [ ] 3. Implement the OpenCode RTK plugin
- [x] 3.1 Build plugin self-check and state handling
  - Add a repo-owned OpenCode plugin that reads the wrapper-exported effective state and telemetry posture at startup.
  - Check RTK binary availability and required OpenCode logging/hook surfaces before registering rewrite behavior.
  - Emit local structured logs for enabled, disabled, missing-binary, unsafe-telemetry, and incompatible-surface states without logging command output.
  - Completed state: disabled or failed self-check states return no rewrite hook and produce a local log record naming the reason.
  - _Depends: 2.1_
  - _Requirements: 3.1, 3.2, 5.2, 5.3, 5.4, 7.1, 7.2_
  - _Boundary: RTK Plugin_

- [x] 3.2 Add Bash and shell command rewrite behavior
  - Handle only OpenCode Bash and shell tool calls and leave native tools unchanged.
  - Run `rtk rewrite` for eligible command text and mutate only the command argument when RTK returns a changed command.
  - Preserve underlying Bash tool execution, success/failure ownership, and pass-through behavior when rewrite fails.
  - Completed state: Bash/shell commands are rewritten when enabled, native tools bypass RTK, and rewrite failures leave the original command with a local failure log.
  - _Depends: 3.1_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 6.8, 7.3, 7.4_
  - _Boundary: RTK Plugin_

- [x] 3.3 Install the plugin through the RTK module
  - Deploy the plugin under the OpenCode local plugin scan path with Home Manager instead of running `rtk init`.
  - Ensure removing or disabling the module removes the managed plugin surface without extra cleanup.
  - Completed state: a rendered Home Manager config contains the RTK plugin file when enabled and omits it when the module is disabled.
  - _Depends: 3.2_
  - _Requirements: 1.2, 1.4, 3.3, 7.5_
  - _Boundary: RTK Module, RTK Plugin_

- [ ] 4. Wire host attribution and host-specific behavior
- [x] 4.1 Update Shopify usage tags to use effective RTK state
  - Replace the static Shopify `rtk:disabled` tag with the wrapper-exported usage tag while preserving existing `opencode_cli` and session-id tags.
  - Ensure enabled, disabled, and per-launch override states produce exactly `rtk:enabled` or `rtk:disabled` in Shopify provider headers.
  - Completed state: rendered Shopify provider headers contain an env-backed RTK tag that matches the plugin's effective state for the launch.
  - _Depends: 2.1_
  - _Requirements: 3.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  - _Boundary: Shopify Integration, State Resolver_

- [x] 4.2 Preserve both-host behavior and host override semantics
  - Keep common enablement active for both target hosts while allowing a host to set RTK disabled by default.
  - Ensure a host default of disabled still permits a per-launch enable override when the package and plugin are available.
  - Completed state: host renders prove Shopify and personal configurations can diverge in default RTK state without duplicating package or plugin logic.
  - _Depends: 4.1_
  - _Requirements: 1.1, 1.5, 3.4, 3.5, 3.6, 3.7, 7.5_
  - _Boundary: RTK Module, State Resolver_

- [ ] 5. Add validation coverage
- [x] 5.1 Add plugin unit tests for state and routing
  - Cover enabled, disabled, missing RTK, unsafe telemetry, invalid command shape, native tool pass-through, Bash/shell rewrite, and rewrite failure cases.
  - Assert local logs contain reason codes but not full command output.
  - Completed state: the plugin test suite fails if native tools are routed, if missing RTK silently enables routing, or if rewrite failure mutates the command.
  - _Depends: 3.2_
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.2, 5.2, 5.3, 5.4, 6.8, 7.1, 7.2, 7.3, 7.4_
  - _Boundary: RTK Plugin, Smoke and Tests_

- [x] 5.2 Add Home Manager render and Shopify tag tests
  - Verify plugin file rendering, metadata rendering, wrapper env exports, OpenCode peer assertion, host default override, and Shopify usage tag values.
  - Cover enabled, disabled, and per-launch override tag states for the Shopify configuration.
  - Assert the integration introduces no writer to the OpenCode session database or historical session data path.
  - Completed state: render tests fail if Shopify tags drift from the effective state, if the module renders without OpenCode enabled, or if session-history writes are introduced.
  - _Depends: 4.2_
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 3.1, 3.4, 3.5, 3.6, 3.7, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.5_
  - _Boundary: RTK Module, Shopify Integration, Smoke and Tests_

- [ ] 5.3 Complete the RTK OpenCode smoke verifier
  - Extend the smoke verifier to check RTK binary availability, version/source identity, plugin file presence, metadata contents, telemetry-disable env, and effective state contract.
  - Use actionable failure labels consistent with existing smoke tests.
  - Completed state: the smoke command exits non-zero with a named failure when the binary, plugin, metadata, telemetry posture, or state contract is wrong.
  - _Depends: 5.2_
  - _Requirements: 1.2, 1.4, 3.1, 4.2, 4.4, 5.1, 5.2, 5.3, 5.4, 7.1, 7.2, 7.5_
  - _Boundary: Smoke and Tests_

- [ ] 5.4 Integrate RTK tests into repository checks
  - Add the RTK test suite to the repo's existing check flow without weakening existing checks.
  - Ensure the new checks exercise the same Node/Nix conventions as existing OpenCode plugin tests.
  - Completed state: `nix flake check` includes RTK tests and still runs existing checks.
  - _Depends: 5.1, 5.2, 5.3_
  - _Requirements: 6.1, 7.4_
  - _Boundary: Smoke and Tests_

- [ ] 6. Complete host validation and measurement handoff
- [ ] 6.1 Validate packages, host evaluations, smoke behavior, and diagnostics
  - Build RTK through both target host package sets and evaluate both Darwin system configurations.
  - Run repository checks and the RTK smoke verifier after the implementation is wired.
  - Confirm no OpenCode session database or historical session data is mutated by enabling, disabling, or removing RTK.
  - Run a before/after `opencode-cost-report` workflow on a Bash-heavy session and compare only Bash tool attribution.
  - Completed state: package builds, host evals, repo checks, smoke tests, non-mutation evidence, and Bash-only measurement evidence are available for review.
  - _Depends: 5.4_
  - _Requirements: 1.1, 1.2, 4.4, 6.1, 6.2, 6.7, 6.8, 7.4_
  - _Boundary: Smoke and Tests, RTK Package, RTK Module_
