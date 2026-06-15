# Requirements Document

## Introduction
This feature installs Hammerspoon declaratively (without Homebrew) on both
nix-darwin hosts and provides an app-agnostic Home Manager options schema for
declaring global keybindings as hotkey-to-action mappings, rendered into a
readable Hammerspoon configuration. The concrete microphone mute-toggle binding
and the removal of Ears are owned by the separate `ears-hammerspoon-migration`
spec. Full problem, approach, and boundary detail are in
`.kiro/specs/hammerspoon-keybindings/brief.md`.

## Boundary Context
- **In scope**: Hammerspoon packaged and installed via Nix (no Homebrew) on both
  hosts; launch-at-login; first-run Accessibility documentation; a declarative
  keybinding options schema; three generic action types (AppleScript,
  command-line, and an inline Lua escape hatch); rendering into a readable
  configuration stored under `$XDG_CONFIG_HOME` (not `~/.hammerspoon`); global
  hotkey firing; auto-reload after a rebuild; validation of
  duplicate, incomplete, and invalid bindings; graceful empty-set rendering;
  derivation-time validation that the generated config is syntactically valid Lua
  and a semantically valid Hammerspoon configuration; flake-check verification
  using test fixtures.
- **Out of scope**: the microphone mute-toggle binding and its feedback (transient
  alert, menubar indicator); removal of Ears; any audio or microphone behavior;
  macOS automation beyond keybindings (window management, app launchers, menubar
  widgets); migrating other existing per-app shortcuts; automating the macOS
  Accessibility grant; Spotlight/Dock indexing helpers such as `mac-app-util`;
  runtime or behavioral verification of the rendered config on a host (the
  validity checks are static, at derivation time).
- **Adjacent expectations**: relies on home-manager providing the per-user
  application install (linked into `~/Applications/Home Manager Apps`) and managing
  the per-user config file; requires a one-time manual Accessibility grant before any
  binding functions (re-granted on a Hammerspoon version bump); `ears-hammerspoon-migration`
  is the downstream consumer of the action-type contract; orthogonal to the
  cost-reduction `roadmap.md`.

## Requirements

### Requirement 1: Declarative per-user Hammerspoon installation without Homebrew
**Objective:** As the operator, I want Hammerspoon installed declaratively for my user from a pinned release, so that the app is reproducible without Homebrew.

#### Acceptance Criteria
1. The operator's Home Manager configuration shall install Hammerspoon from a pinned, signed upstream release artifact (a Nix package) without using Homebrew.
2. The operator's Home Manager configuration shall install Hammerspoon for the operator's user on both `ShopifyLaptop` and `Brandons-MacBook-Pro`.
3. When `darwin-rebuild switch` completes, the operator's Home Manager configuration shall make Hammerspoon available in the per-user Applications location (`~/Applications/Home Manager Apps`).
4. When Hammerspoon is installed, the operator's Home Manager configuration shall link it into the per-user Applications folder so it is launchable from Finder; Spotlight and Launchpad visibility of the linked bundle is best-effort.
5. While the pinned Hammerspoon version is unchanged across a rebuild, the operator's Home Manager configuration shall preserve the previously granted macOS Accessibility permission without requiring operator re-approval.
6. When a newer Hammerspoon version is pinned and applied, the operator's Home Manager configuration shall install the new version for the user; the macOS Accessibility permission may require one-time re-approval because the per-user install resolves to a version-specific store path.
7. When the operator logs in, Hammerspoon shall start automatically so that the declared keybindings are active without the operator manually launching it.
8. If the pinned release artifact cannot be fetched or fails integrity verification, then the build shall fail with an error identifying the Hammerspoon package, and shall not install a partial or unverified application.

### Requirement 2: First-run Accessibility enablement
**Objective:** As the operator, I want the one-time manual Accessibility requirement made explicit, so that I understand why bindings are inert until I grant it.

#### Acceptance Criteria
1. While Hammerspoon has not been granted macOS Accessibility permission, Hammerspoon shall not deliver any declared global keybinding action.
2. The keybinding module shall document that a one-time manual Accessibility grant is required after the first install on each host.
3. When Accessibility permission is granted to the installed Hammerspoon, the declared global keybindings shall become active without further configuration changes.

### Requirement 3: Declarative global keybinding framework
**Objective:** As the operator, I want to declare global keybindings in Nix as hotkey-to-action mappings, so that shortcuts are readable and reviewable instead of opaque per-app preference blobs.

#### Acceptance Criteria
1. The keybinding module shall accept a declarative set of keybindings in which each binding specifies a hotkey (a set of modifier keys plus one key) and exactly one action.
2. The keybinding module shall support three action types for a binding: an AppleScript to run, a command-line invocation to run, and an inline Lua snippet to execute as a general escape hatch for invoking system APIs.
3. When the hotkey of a declared binding is pressed while any application is focused, Hammerspoon shall perform that binding's action.
4. The keybinding module shall render the declared bindings into a human-readable configuration file that is reviewable as plain text in a diff.
5. When `darwin-rebuild switch` applies a change to the declared keybindings, Hammerspoon shall begin honoring the changed bindings without the operator manually restarting or reloading Hammerspoon.
6. When no keybindings are declared, the keybinding module shall render a valid configuration that Hammerspoon loads without error.
7. If two declared bindings specify the same hotkey, then the build shall fail with an error that identifies the conflicting hotkey, and shall not produce an ambiguous configuration.
8. If a declared binding omits its hotkey or its action, then the build shall fail with an error identifying the incomplete binding.
9. If a declared binding specifies an unsupported modifier or key, then the build shall fail with an error identifying the binding.

### Requirement 4: Verification
**Objective:** As the operator, I want to validate the package and rendered configuration without switching a host, so that breakage is caught before activation.

#### Acceptance Criteria
1. The flake checks shall build the Hammerspoon package on the supported darwin system.
2. The flake checks shall verify that representative declared keybindings render the expected configuration content.
3. When a declared set of keybindings contains a duplicate hotkey, an incomplete binding, or an unsupported modifier or key, the flake checks shall fail.
4. The flake checks shall complete without requiring Hammerspoon to be installed or granted Accessibility on the build host.

### Requirement 5: Generated configuration validity
**Objective:** As the operator, I want the generated Hammerspoon configuration proven valid at build time, so that an invalid configuration can never be installed or silently loaded.

#### Acceptance Criteria
1. The generated Hammerspoon configuration shall be syntactically valid Lua.
2. The generated Hammerspoon configuration shall be a semantically valid Hammerspoon configuration, referencing only Hammerspoon API modules, functions, and fields that exist.
3. If the generated configuration is not syntactically valid Lua, then a derivation-time check shall fail the build with an error identifying the syntax error.
4. If the generated configuration references a Hammerspoon API module, function, or field that does not exist, then a derivation-time check shall fail the build with an error identifying the offending reference.
5. The validity checks shall run at derivation time without a running Hammerspoon instance or a macOS Accessibility grant.

### Requirement 6: XDG configuration file location
**Objective:** As the operator, I want Hammerspoon's configuration kept under `XDG_CONFIG_HOME`, so that the home directory stays uncluttered and config follows the XDG Base Directory convention.

#### Acceptance Criteria
1. The keybinding module shall place the generated Hammerspoon configuration under `$XDG_CONFIG_HOME` (at `$XDG_CONFIG_HOME/hammerspoon/init.lua`), not under `~/.hammerspoon`.
2. The configuration shall direct Hammerspoon to load its configuration from the `$XDG_CONFIG_HOME` location.
3. When activation completes, the keybinding module shall leave no Hammerspoon configuration file under `~/.hammerspoon`.
