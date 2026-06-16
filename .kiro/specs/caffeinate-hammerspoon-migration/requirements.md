# Requirements Document

## Introduction
This feature replaces the `domzilla-caffeine` menu-bar app (personal host) and
the always-on `caffeinate -dimsu` zellij pane (Shopify host) with a single
declarative, menu-bar caffeinate toggle built on the implemented
`hammerspoon-keybindings` framework, and removes both legacy mechanisms. Full
problem, approach, scope, and constraints are in
`.kiro/specs/caffeinate-hammerspoon-migration/brief.md`.

## Boundary Context
- **In scope**: a menu-bar item that toggles caffeinate on click; sleep
  prevention equivalent to `caffeinate -dimsu` while enabled; a menu-bar
  indicator distinguishing enabled from disabled; silent toggling (no alert or
  notification); persistence of the on/off state across Hammerspoon reloads and
  restarts; removal of the `domzilla-caffeine` cask (personal) and the
  `caffeinate -dimsu` zellij pane (Shopify); static flake-check coverage of the
  rendered configuration on both hosts.
- **Out of scope**: the Hammerspoon install, the keybinding framework, the XDG
  config location/auto-reload, and the generic action types (owned by
  `hammerspoon-keybindings`); a global hotkey for caffeinate; timed, scheduled,
  or auto-off caffeinate; per-application or battery-aware behavior; preventing
  disk-idle sleep (`caffeinate -m` has no Hammerspoon equivalent); automating the
  Accessibility grant.
- **Adjacent expectations**: the toggle is delivered through the framework's
  `extraConfig` escape hatch under the framework's XDG config path and runs
  whenever Hammerspoon runs (started at login by the framework's launchd agent);
  unlike global hotkeys, the menu-bar toggle and sleep prevention do not depend
  on the one-time Accessibility grant; the system-sleep portion of the assertion
  is honored by macOS only while the host is on AC power; runtime sleep behavior
  is validated by operator smoke testing, not by the static flake checks.

## Requirements

### Requirement 1: Menu-bar caffeinate toggle
**Objective:** As the operator, I want to click a menu-bar item to turn caffeinate on or off, so that I can keep my Mac awake on any host without a separate menu-bar app or a terminal-pinned `caffeinate` process.

#### Acceptance Criteria
1. The Hammerspoon configuration shall maintain a persistent menu-bar item that controls caffeinate.
2. When the operator clicks the menu-bar item while caffeinate is disabled, Hammerspoon shall enable caffeinate.
3. When the operator clicks the menu-bar item while caffeinate is enabled, Hammerspoon shall disable caffeinate.
4. When the operator clicks the menu-bar item, Hammerspoon shall toggle caffeinate directly without requiring the operator to open a menu.

### Requirement 2: Sleep prevention while enabled
**Objective:** As the operator, I want enabled caffeinate to keep the machine and display awake the way `caffeinate -dimsu` did, so that the Mac does not sleep while I am relying on it staying awake.

#### Acceptance Criteria
1. While caffeinate is enabled, Hammerspoon shall prevent the display from sleeping due to inactivity.
2. While caffeinate is enabled, Hammerspoon shall prevent the system from idle-sleeping.
3. While caffeinate is enabled and the host is on AC power, Hammerspoon shall prevent the system from sleeping.
4. While caffeinate is disabled, Hammerspoon shall allow the display and system to sleep under the operating system's normal energy settings.

### Requirement 3: State indicator
**Objective:** As the operator, I want the menu-bar icon to show whether caffeinate is on or off, so that I know the current state at a glance.

#### Acceptance Criteria
1. While caffeinate is enabled, the menu-bar item shall display an indicator distinct from its disabled indicator.
2. While caffeinate is disabled, the menu-bar item shall display an indicator distinct from its enabled indicator.
3. When caffeinate state changes, the menu-bar item shall update its indicator to reflect the new state.

### Requirement 4: Silent toggling
**Objective:** As the operator, I want toggling to be silent, so that turning caffeinate on or off does not interrupt me with notifications.

#### Acceptance Criteria
1. When caffeinate is toggled, Hammerspoon shall not display an on-screen alert.
2. When caffeinate is toggled, Hammerspoon shall not post a notification, banner, or sound.

### Requirement 5: State persistence across reloads and restarts
**Objective:** As the operator, I want the caffeinate state to survive Hammerspoon reloads and restarts, so that a config rebuild or login does not silently drop caffeinate.

#### Acceptance Criteria
1. When caffeinate is toggled, Hammerspoon shall persist the new on/off state.
2. While caffeinate was enabled before a Hammerspoon reload or restart, Hammerspoon shall restore the enabled state and re-apply sleep prevention after the reload or restart.
3. While caffeinate was disabled before a Hammerspoon reload or restart, Hammerspoon shall restore the disabled state after the reload or restart.
4. When the restored state is applied after a reload or restart, the menu-bar indicator shall reflect that state.
5. Where no previously persisted caffeinate state exists, Hammerspoon shall start with caffeinate disabled.

### Requirement 6: Removal of legacy caffeinate mechanisms
**Objective:** As the operator, I want the old caffeinate app and the terminal-pinned `caffeinate` process removed, so that caffeinate is owned entirely by the reviewable Hammerspoon configuration.

#### Acceptance Criteria
1. The operator's personal darwin configuration shall not include the `domzilla-caffeine` Homebrew cask.
2. The operator's Shopify configuration shall not include the `caffeinate -dimsu` zellij pane.
3. When `darwin-rebuild switch` completes on the personal host after the cask is removed, the Caffeine application shall no longer be installed.
4. The operator's configuration shall deliver the Hammerspoon caffeinate toggle on a host in the same change that removes that host's legacy caffeinate mechanism, so that caffeinate is never absent after a host switch.

### Requirement 7: Verification without a host switch
**Objective:** As the operator, I want the rendered caffeinate configuration validated before activation, so that an invalid configuration is caught without switching a host.

#### Acceptance Criteria
1. The flake checks shall verify that the rendered caffeinate configuration is a semantically valid Hammerspoon configuration that references only existing `hs` API modules, functions, and fields.
2. The flake checks shall verify that the caffeinate menu-bar toggle is present in the configuration rendered for both hosts.
3. The flake checks shall verify that the personal configuration omits the `domzilla-caffeine` cask and the Shopify configuration omits the `caffeinate -dimsu` zellij pane.
4. The flake checks shall complete without installing Hammerspoon, running Hammerspoon, or granting Accessibility on the build host.
