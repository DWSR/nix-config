# Implementation Plan

> Reuses the implemented `hammerspoon-keybindings` framework as-is: the
> `home.hammerspoon` schema (`extraConfig`), the renderer, the delivery-path
> syntax gate (`checked-config.nix`), `mkSemanticCheck`,
> `pkgs.hammerspoonHsAnnotations`, and `home.hammerspoon.enable = true` in the
> shared common config. No new build infrastructure is introduced. Sibling
> precedent: `hammerspoon-mic-mute`.

- [x] 1. Author the caffeinate Hammerspoon Lua runtime
  - Maintain a persistent menu-bar item whose single click toggles caffeinate between enabled and disabled, with no dropdown menu.
  - On enable, assert the `displayIdle` + `systemIdle` + `system` sleep types; on disable, clear all three.
  - Indicate the current state with two visually-distinct menu-bar indicators (plus a tooltip), repainting on every state change.
  - Toggle silently: never show an on-screen alert, notification, banner, or sound.
  - Persist the on/off state and, on load/reload, restore it (defaulting to disabled when no state is stored) and re-apply the assertions, since the assertions do not survive a reload.
  - Hold the menu-bar handle in a plain local upvalue, never a `nil`-initialized table field, so it is closure-retained against GC and the semantic check does not false-positive.
  - Carry a stable sentinel comment the wiring check can assert on.
  - Observable completion: the Lua passes `luac -p` and `stylua --check`, and building `mkSemanticCheck` over a cfg embedding this Lua succeeds ("no problems found").
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Boundary: Caffeinate Lua_

- [x] 2. Declare the consumer Home Manager module and wire it
  - Create the Home Manager module that delivers the caffeinate Lua via `home.hammerspoon.extraConfig` and sets no keybindings (menu-bar only).
  - Import the module into the shared common Home Manager config so the toggle reaches both hosts.
  - Observable completion: evaluating each host config shows the caffeinate sentinel present in the rendered `home.hammerspoon` config, and the live `hammerspoon/init.lua` rebuilds through the framework syntax gate without error.
  - _Requirements: 6.4_
  - _Boundary: Caffeinate HM Module_

- [x] 3. (P) Remove the legacy caffeinate mechanisms
  - Remove the `domzilla-caffeine` cask from the personal host's Homebrew cask list.
  - Remove the `caffeinate -dimsu` pane from the Shopify zellij stats-tab layout (and its layout-comment mention), keeping the `mcpproxy tui` pane.
  - Observable completion: the personal host config evaluates with no `domzilla-caffeine` in `homebrew.casks`; the Shopify rendered zellij default layout contains no `caffeinate` command pane; on the next switch, Homebrew cleanup uninstalls the Caffeine app.
  - Commit together with task 2 so caffeinate is never absent after a host switch (6.4); separate files/boundary from tasks 1-2, no functional dependency.
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: Caffeinate Teardown_

- [ ] 4. Verification flake checks
- [x] 4.1 Semantic check over the caffeinate config
  - Add `hammerspoon-caffeinate-semantic` inside the existing aarch64-gated `hammerspoonChecks` block, building `mkSemanticCheck` over an isolated caffeinate cfg (empty keybindings, `extraConfig` = the caffeinate Lua); do not modify the framework's or mic-mute's existing checks.
  - Observable completion: `nix build .#checks.aarch64-darwin.hammerspoon-caffeinate-semantic` succeeds; substituting a nonexistent `hs` symbol fails it.
  - _Requirements: 7.1, 7.4_
  - _Boundary: Verification_
  - _Depends: 1_

- [ ] 4.2 Wiring and removal assertions
  - Add `hammerspoon-caffeinate-wiring`: per-host (`ShopifyLaptop`, `Brandons-MacBook-Pro`) eval assertions that the caffeinate sentinel is present in each host's rendered config, that `domzilla-caffeine` is absent from the personal host's `homebrew.casks`, and that the Shopify rendered zellij layout has no `caffeinate` command pane.
  - Observable completion: `nix build .#checks.aarch64-darwin.hammerspoon-caffeinate-wiring` succeeds for both hosts; an injected missing sentinel, a residual cask, or a residual pane makes it fail at eval.
  - _Requirements: 7.2, 7.3, 6.1, 6.2_
  - _Boundary: Verification_
  - _Depends: 2, 3_

## Implementation Notes
- Task 1: The object-handle premise is incomplete as previously documented. The generated `hs.menubar.new` annotation has an empty body and no `---@return`, so `lua-language-server` infers the handle as `nil` (not "untyped"). EVERY method call on an `hs.menubar` handle — including `:setClickCallback`, not just `:setTitle`/`:setTooltip` — must sit behind a non-nil guard (`if not h then return end` or `if h then ... end`) or it fails `undefined-field`. Rule: hold the handle as a plain `local` AND nil-guard every method call on it. mic-mute.lua only ever calls handle methods inside its `updateMenubar` guard, so it never exercised an unguarded call.
