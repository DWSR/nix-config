# Implementation Plan

> Reuses the implemented `hammerspoon-keybindings` framework as-is: the
> `home.hammerspoon` schema (`keybindings`/`extraConfig`), the renderer, the
> delivery-path syntax gate (`checked-config.nix`), `mkSemanticCheck`,
> `pkgs.hammerspoonHsAnnotations`, and `home.hammerspoon.enable = true` in the
> shared common config. No new build infrastructure is introduced.

- [x] 1. Author the mic-mute Hammerspoon Lua runtime
  - Toggle the system default input device's mute on each invocation: resolve the current default device per call (fresh handle, never cached), mute when unmuted and unmute when muted.
  - Prefer the hardware mute control; when the device reports no hardware mute (a false/nil return), fall back to setting input volume to silent on mute and restoring the pre-mute level on unmute, tracking the logical mute state and the cached level.
  - Show a transient on-screen alert reflecting the new state (muted/unmuted) on each toggle.
  - Create and maintain a persistent menubar item with distinct muted vs unmuted indicators, held in a plain local upvalue (never a `nil`-initialized table field) so it is closure-retained against GC and the semantic check does not false-positive.
  - Register the system default-input-device watcher and, on the `dIn ` event, resync the logical state from the new default device and refresh the indicator.
  - Expose the toggle as a chunk-scope function callable from the binding's inline-Lua action.
  - Observable completion: the Lua file passes `luac -p` and `stylua --check`, and building `mkSemanticCheck` over a cfg embedding this Lua succeeds ("no problems found").
  - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 4.1, 4.2_
  - _Boundary: Mic Mute Lua_

- [x] 2. Declare the ⌃⌘⇧F12 binding and wire the module
  - Create the Home Manager module that sets `home.hammerspoon.keybindings` to a single binding (mods ctrl+cmd+shift, key F12, an inline-Lua action invoking the toggle) and delivers the Lua via `home.hammerspoon.extraConfig`.
  - Import the module into the shared common Home Manager config so the binding reaches both hosts.
  - Observable completion: evaluating each host config shows exactly one `home.hammerspoon` keybinding with mods {ctrl,cmd,shift}, key F12, and a non-null lua action, and the live `hammerspoon/init.lua` rebuilds through the framework syntax gate without error.
  - _Requirements: 1.3, 5.4_
  - _Boundary: Mic Mute HM Module_
  - _Depends: 1_

- [x] 3. (P) Remove Ears
  - Drop the `ears` cask from the darwin Homebrew cask list, delete the `ears.nix` activation-script shortcut blob, and remove its import.
  - Observable completion: each host config evaluates with no `ears` entry in `homebrew.casks` and no `ears.nix` import, and the file no longer exists; on the next switch Homebrew cleanup uninstalls the Ears app.
  - Commit together with task 2 so mic-mute is never absent after a host switch (5.4); separate files/boundary from tasks 1-2, no functional dependency.
  - _Requirements: 5.1, 5.2, 5.3_
  - _Boundary: Ears Teardown_

- [ ] 4. Verification flake checks
- [x] 4.1 Semantic check over the live mic-mute config
  - Add `hammerspoon-mic-mute-semantic` inside the existing aarch64-gated `hammerspoonChecks` block, building `mkSemanticCheck` over a host's live `home.hammerspoon` cfg (real Lua, no fixture copy); do not modify the framework's existing checks.
  - Observable completion: `nix build .#checks.aarch64-darwin.hammerspoon-mic-mute-semantic` succeeds; substituting a nonexistent `hs` symbol fails it.
  - _Requirements: 6.1, 6.3_
  - _Boundary: Verification_
  - _Depends: 2_

- [x] 4.2 Wiring and teardown assertions
  - Add `hammerspoon-mic-mute-wiring`: per-host (`ShopifyLaptop`, `Brandons-MacBook-Pro`) eval assertions that the ⌃⌘⇧F12 lua binding is present and that `ears` is absent from `homebrew.casks`, mirroring the framework's host-wiring assert pattern.
  - Observable completion: `nix build .#checks.aarch64-darwin.hammerspoon-mic-mute-wiring` succeeds for both hosts; an injected missing binding or a residual `ears` cask makes it fail at eval.
  - _Requirements: 6.2, 6.3, 5.1, 5.4_
  - _Boundary: Verification_
  - _Depends: 2, 3_
