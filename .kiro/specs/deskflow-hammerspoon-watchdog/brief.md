# Brief: deskflow-hammerspoon-watchdog

## Problem
The operator reports: "Deskflow occasionally crashes on the personal host
(the server) and it takes several moments for things to recover." Deskflow
1.26.0 does not restart its core after a non-zero or crash exit, leaving shared
keyboard and mouse control unavailable until the operator notices and recovers
it manually.

## Current State
The shared `home.deskflow` module configures client and server roles but
explicitly excludes core-process autostart and supervision. Hammerspoon runs on
both hosts and accepts feature-owned Lua through `home.hammerspoon.extraConfig`.
Deskflow's GUI normally owns `deskflow-core`; stable 1.26.0 exposes no macOS CLI
or IPC operation for restarting that core.

## Desired Outcome
An optional Hammerspoon feature detects when the expected Deskflow core is
absent and restores it through Deskflow's GUI without operator action. The
feature supports both Deskflow roles, treats any stop as recoverable while
enabled, and is initially enabled only on the personal server.

## Approach
Add a role-aware Hammerspoon watchdog that checks the exact Deskflow core
process after startup and wake grace periods. After debounced absence, it
launches or activates Deskflow, discovers the enabled Start/Connect GUI action,
and invokes it through Accessibility automation. Recovery is serialized and
bounded by cooldown/backoff; unsafe or ambiguous states fail closed and produce
a throttled operator alert.

Direct core launch and launchd supervision are rejected because they bypass or
compete with Deskflow GUI ownership.

## Scope
- **In**: optional Home Manager enablement; client and server role support;
  exact process-identity checks; missing-core detection; GUI-owned recovery;
  startup and wake grace; serialized retries; cooldown/backoff; failure alerts;
  personal-server enablement; static and host-wiring verification.
- **Out**: hung-core responsiveness checks; automatic remediation of orphaned
  or multiple cores; direct `deskflow-core` launch; launchd core supervision;
  Deskflow settings, TLS, layouts, or installation; Hammerspoon packaging;
  enabling the watchdog on ShopifyLaptop in the initial rollout.

## Boundary Candidates
- A reusable optional Home Manager feature that contributes validated Lua to
  the existing Hammerspoon configuration.
- A Lua watchdog state machine that owns observation, recovery serialization,
  lifecycle grace, backoff, and operator feedback.
- Host wiring and checks that prove role propagation and personal-only rollout.

## Out of Boundary
- Changes to `.kiro/specs/deskflow-config` or its static renderer.
- Changes to `.kiro/specs/hammerspoon-keybindings` or its generic renderer and
  validation contracts.
- General-purpose process supervision or health-check infrastructure.
- Recovery based on network connectivity, peer availability, or temporary
  Deskflow disconnection while the core remains alive.
- Automatic killing of processes in an ambiguous state.

## Upstream / Downstream
- **Upstream**: `home.deskflow` supplies enabled state and `client`/`server`
  role; `home.hammerspoon` supplies `extraConfig`, Accessibility, XDG delivery,
  syntax validation, and semantic validation; the Homebrew cask supplies
  Deskflow 1.26.0.
- **Downstream**: optional rollout to the Shopify client and future adaptation
  to an upstream Deskflow IPC restart API.

## Existing Spec Touchpoints
- **Extends**: none. This feature consumes completed extension points without
  reopening their specifications.
- **Adjacent**: `deskflow-config` owns static role-aware configuration;
  `hammerspoon-keybindings` owns the generic Hammerspoon framework;
  existing Hammerspoon feature modules establish the optional-module pattern.

## Constraints
- macOS on the two aarch64-darwin hosts.
- Deskflow GUI remains the sole owner that starts `deskflow-core`.
- Enabled means intentional quit or stop is recovered.
- Missing-core recovery only; process presence is not a responsiveness signal.
- Process matching must verify bundle-derived executable identity and expected
  role rather than relying on a broad process-name match.
- Recovery must never use `--new-instance`, launch the core directly, or kill
  an ambiguous process.
- Hammerspoon and Deskflow require separate manual Accessibility grants.
- Menu discovery must tolerate role-specific labels and fail safely when no
  enabled start action is available.
