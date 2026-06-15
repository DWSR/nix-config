# Brief: ears-hammerspoon-migration

## Problem
The Ears Insta-Mute hotkey (Fn+F12) is stored as an opaque `NSKeyedArchive` hex
blob in `configurations/common-darwin/ears.nix`, written by an activation script.
It is unreadable, unreviewable in a diff, and is the only way to change the
mic-mute shortcut. Ears also runs as a separate menu-bar app solely for this.

## Current State
- Ears is installed as a Homebrew cask (`ears` in `homebrew.casks`); its mute
  hotkey is the hex blob in `ears.nix`. App prefs are clean
  `CustomUserPreferences`; only the keybinding is the blob.
- The `hammerspoon-keybindings` framework (this spec's dependency) provides a
  declarative hotkey-to-action mechanism with generic action types, but ships no
  real binding.

## Desired Outcome
A global ⌃⌘⇧F12 hotkey toggles the system default microphone mute, with a
transient on-screen alert and a persistent menubar state indicator. Ears and its
opaque blob are removed; the mic-mute concern is owned entirely by the
declarative Hammerspoon binding.

## Approach
Build the mic-mute binding on top of the `hammerspoon-keybindings` action-type
contract (the inline-Lua / system escape hatch):
- Bind ⌃⌘⇧F12 to toggle `hs.audiodevice.defaultInputDevice():setInputMuted(...)`,
  acting on whatever the current default input device is.
- Show a transient `hs.alert` on each toggle and maintain an `hs.menubar` item
  reflecting mute state.
- For input devices without a hardware mute control, fall back to driving input
  volume so the toggle still effectively mutes and unmutes.
- Remove the `ears` cask from `homebrew.casks` and delete `ears.nix` (and its
  import). Land the binding and the removal together so mic-mute is never absent
  on a switched host.

## Scope
- **In**: the ⌃⌘⇧F12 mic mute toggle on the default input device; the
  no-hardware-mute fallback; default-input-device change handling; transient
  alert feedback; persistent menubar mute-state indicator; removal of the Ears
  cask and `ears.nix`; flake-check coverage of the rendered binding.
- **Out**: the keybinding framework, Hammerspoon install, and generic action
  types (owned by `hammerspoon-keybindings`); muting individual apps; tracking
  mute changes made by other applications; per-app audio routing.

## Boundary Candidates
- The mic-mute action: toggle logic + default-device resolution + fallback.
- Feedback surfaces: transient alert and persistent menubar indicator.
- Ears teardown: cask removal, `ears.nix` deletion, import cleanup.

## Out of Boundary
- The framework's options schema, action-type contract, install, and rendering.
- Any keybinding other than the mic toggle.
- Audio routing, device-selection UI, or per-application mute.

## Upstream / Downstream
- **Upstream**: `hammerspoon-keybindings` (the framework, action-type contract,
  Hammerspoon install, and Accessibility grant); the Hammerspoon `hs.audiodevice`,
  `hs.alert`, and `hs.menubar` APIs; `configurations/common-darwin` (cask list +
  `ears.nix`).
- **Downstream**: none expected; serves as the reference example for future
  bindings.

## Existing Spec Touchpoints
- **Extends**: none (new spec).
- **Adjacent / depends on**: `hammerspoon-keybindings` (hard dependency). Touches
  `configurations/common-darwin/default.nix` (cask list) and removes
  `configurations/common-darwin/ears.nix`.

## Constraints
- macOS / aarch64-darwin, both hosts (`ShopifyLaptop`, `Brandons-MacBook-Pro`).
- Requires the `hammerspoon-keybindings` framework and a granted Accessibility
  permission to function.
- Hammerspoon cannot reliably bind the `fn` modifier, so the old Fn+F12 is
  replaced by ⌃⌘⇧F12.
- No native on-screen mute bezel exists; feedback is the alert + menubar
  indicator.
- Homebrew `cleanup = "zap"` removes the Ears cask once it is dropped from the
  list.
- Mic-mute API caveats: `memories/2026-06-14-hammerspoon-nix-darwin-packaging.md`.
