# Requirements Document

## Introduction
This feature replaces the Ears Insta-Mute app with a declarative microphone
mute-toggle binding built on the implemented `hammerspoon-keybindings`
framework, and removes Ears and its opaque `NSKeyedArchive` shortcut blob. Full
problem, approach, scope, and constraints are in
`.kiro/specs/ears-hammerspoon-migration/brief.md`.

## Boundary Context
- **In scope**: the global ⌃⌘⇧F12 toggle of the system default input device's
  mute; the no-hardware-mute input-volume fallback; default-input-device change
  handling; a transient on-screen alert; a persistent menubar mute-state
  indicator; removal of the Ears cask and `ears.nix`; static flake-check coverage
  of the rendered binding.
- **Out of scope**: the keybinding framework, the Hammerspoon install, the XDG
  config location/auto-reload, and the generic action types (owned by
  `hammerspoon-keybindings`); muting individual applications; tracking mute
  changes made by other applications; per-application audio routing; automating
  the Accessibility grant; binding the `fn` modifier.
- **Adjacent expectations**: the binding is declared through the framework's
  inline-Lua action and `extraConfig` escape hatch and is delivered under the
  framework's XDG config path; it is inert until the framework's one-time manual
  Accessibility grant is in place (re-granted on a Hammerspoon version bump);
  toggling mute via CoreAudio property control needs no separate macOS Microphone
  permission. Runtime mute behavior is validated by operator smoke testing, not
  by the static flake checks.

## Requirements

### Requirement 1: Microphone mute toggle on the default input device
**Objective:** As the operator, I want a global ⌃⌘⇧F12 hotkey that toggles my microphone's mute, so that I can mute and unmute from any application without the Ears menu-bar app.

#### Acceptance Criteria
1. When the operator presses ⌃⌘⇧F12 while the system default input device is unmuted, Hammerspoon shall mute that device.
2. When the operator presses ⌃⌘⇧F12 while the system default input device is muted, Hammerspoon shall unmute that device.
3. When ⌃⌘⇧F12 is pressed while any application is focused, Hammerspoon shall perform the mute toggle.

### Requirement 2: No-hardware-mute fallback
**Objective:** As the operator, I want the toggle to work on input devices that lack a hardware mute control, so that the shortcut reliably mutes any microphone.

#### Acceptance Criteria
1. When the operator toggles mute on an input device that supports a hardware mute control, Hammerspoon shall set that device's mute state directly.
2. If the current default input device does not support a hardware mute control, then Hammerspoon shall mute it by setting its input volume to silent.
3. When the operator unmutes an input device that was muted through the input-volume fallback, Hammerspoon shall restore the input level that was in effect before it was muted.

### Requirement 3: Mute-state feedback
**Objective:** As the operator, I want immediate and at-a-glance feedback on mute state, so that I always know whether my microphone is live without a dedicated app bezel.

#### Acceptance Criteria
1. When the mic-mute state is toggled, Hammerspoon shall display a transient on-screen alert indicating the new state (muted or unmuted).
2. The Hammerspoon configuration shall maintain a persistent menubar item that reflects the current mute state of the system default input device.
3. While the system default input device is muted, the menubar item shall display a muted indicator distinct from its unmuted indicator.

### Requirement 4: Default-input-device change handling
**Objective:** As the operator, I want the toggle and indicator to follow my current default microphone, so that switching devices (for example, connecting AirPods) keeps the shortcut and indicator correct.

#### Acceptance Criteria
1. The mic-mute toggle shall act on whichever input device is the system default at the time the hotkey fires.
2. When the system default input device changes, the menubar item shall update to reflect the new default input device's current mute state.

### Requirement 5: Removal of Ears
**Objective:** As the operator, I want Ears and its opaque shortcut blob removed, so that the mic-mute concern is owned entirely by the reviewable Hammerspoon binding with no separate menu-bar app or `NSKeyedArchive` blob.

#### Acceptance Criteria
1. The operator's darwin configuration shall not include the `ears` Homebrew cask.
2. The operator's darwin configuration shall not include the `ears.nix` activation-script shortcut blob or its import.
3. When `darwin-rebuild switch` completes after the cask is removed, the Ears application shall no longer be installed on the host.
4. The operator's configuration shall deliver the mic-mute binding in the same change that removes Ears, so that the mic-mute capability is never absent after a host switch.

### Requirement 6: Verification without a host switch
**Objective:** As the operator, I want the rendered mic-mute binding validated before activation, so that an invalid binding is caught without switching a host.

#### Acceptance Criteria
1. The flake checks shall verify that the rendered mic-mute configuration is a semantically valid Hammerspoon configuration that references only existing `hs` API modules, functions, and fields.
2. The flake checks shall verify that the ⌃⌘⇧F12 mic-mute binding is present in the configuration rendered for both hosts.
3. The flake checks shall complete without installing Hammerspoon, running Hammerspoon, or granting Accessibility on the build host.
