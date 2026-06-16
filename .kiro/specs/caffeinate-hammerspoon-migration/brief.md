# Brief: caffeinate-hammerspoon-migration

## Problem
Keep-awake is handled by two different ad-hoc mechanisms across the hosts: the
`domzilla-caffeine` menu-bar app (personal) and an always-on `caffeinate -dimsu`
process pinned in a zellij pane (Shopify). The user wants one declarative,
Hammerspoon-based menu-bar toggle on both hosts and to retire both legacy paths,
consistent with the mic-mute migration.

## Current State
- Personal: `domzilla-caffeine` Homebrew cask (`configurations/personal/default.nix:55`) — menu-bar app, click to toggle, icon reflects state.
- Shopify: `caffeinate -dimsu` runs in the zellij "stats" pane (`configurations/shopify/home-manager/zellij.nix:41-44`) — always-on while the pane lives, no toggle, no indicator.
- The `home.hammerspoon` framework is enabled on both hosts (`home-manager/common/default.nix` imports `hammerspoon-keybindings` + `hammerspoon-mic-mute`, sets `home.hammerspoon.enable = true`). `hammerspoon-mic-mute` is the working menu-bar consumer precedent.

## Desired Outcome
- A Hammerspoon menu-bar item on both hosts; clicking it toggles caffeinate.
- The menu-bar icon distinctly indicates enabled vs disabled.
- Toggling produces no alert, banner, sound, or other notification.
- When enabled, caffeinate prevents the same sleep set as `caffeinate -dimsu` (display + system idle + system).
- The on/off state persists across Hammerspoon reloads and restarts.
- `domzilla-caffeine` cask removed (personal); `caffeinate -dimsu` zellij pane removed (Shopify).

## Approach
New consumer module of the `home.hammerspoon` framework, mirroring
`hammerspoon-mic-mute`: `home-manager/common/hammerspoon-caffeinate/`
(`default.nix` + `caffeinate.lua`). The Lua holds an `hs.menubar` handle in a
plain upvalue, drives `hs.caffeinate.set(...)` assertions, persists state via
`hs.settings`, registers a click callback that toggles and repaints the icon,
and emits no `hs.alert`. Delivered through the framework's `extraConfig` escape
hatch with no keybinding (menu-bar click only). The cask and the zellij pane are
removed in the same change so neither host loses caffeinate during the switch.

## Scope
- **In**: new `hammerspoon-caffeinate` consumer module (`caffeinate.lua` + nix wiring); menu-bar click toggle; enabled/disabled icon indicator; state persistence across reloads; removal of `domzilla-caffeine` cask; removal of the Shopify zellij caffeinate pane; flake checks mirroring the mic-mute semantic + host-wiring checks.
- **Out**: a keybinding for caffeinate; timed/auto-off or scheduled caffeinate; per-app or battery-aware behavior; any change to the `hammerspoon-keybindings` framework; the disk-idle (`-m`) assertion (no `hs.caffeinate` API).

## Boundary Candidates
- Caffeinate runtime (`caffeinate.lua`: assertions, menubar, persistence, click handler).
- Nix wiring (consumer `default.nix` feeding keybinding-less `extraConfig`; import into `home-manager/common`).
- Legacy removal (personal cask; Shopify zellij pane).
- Verification (semantic check over each host's live config; wiring check asserting the cask and pane are gone).

## Out of Boundary
- The `home.hammerspoon` framework (`hammerspoon-keybindings`) — consumed unchanged; no new framework options.
- The `hammerspoon-mic-mute` module — untouched.
- The annotation generator's missing `@return` (object-handle rule applies; no framework fix here).

## Upstream / Downstream
- **Upstream**: `hammerspoon-keybindings` framework (enabled on both hosts) provides the `extraConfig` escape hatch, syntax + semantic build gates, the login launchd agent, and the relocated `MJConfigFile`/configdir. `ears-hammerspoon-migration` established the menu-bar consumer pattern.
- **Downstream**: future menu-bar-only Hammerspoon consumers can copy this no-keybinding pattern.

## Existing Spec Touchpoints
- **Extends**: none (consumes `hammerspoon-keybindings` without modifying it).
- **Adjacent**: `ears-hammerspoon-migration` — sibling consumer; same framework, same object-handle authoring rule, same flake-check shape. Avoid touching its mic-mute files/checks.

## Constraints
- macOS / aarch64-darwin, both hosts (`ShopifyLaptop`, `Brandons-MacBook-Pro`).
- Object-handle rule: hold the `hs.menubar` handle in a plain `local`, never a nil-initialized table field, or `lua-language-server --check` false-positives `undefined-field` (`memories/2026-06-15-hammerspoon-semantic-check-object-handle-rule.md`).
- No `hs.alert`/notification on toggle (explicit requirement).
- `hs.caffeinate` exposes `displayIdle`/`systemIdle`/`system`; `caffeinate -m` (disk idle) has no equivalent — design must settle how the `-dimsu` mapping treats that gap.
- Persistence via `hs.settings` must survive reload; the launchd agent runs `KeepAlive = false` (start once at login). Confirm the settings store resolves under the relocated configdir.
- Pre-commit guards: no `builtins.fetch*`, no `/tmp/`, no hardcoded `/Users/` (use `${username}`); `nixfmt`/`statix`/`deadnix` clean; `stylua` + `luac` + `lua-language-server` gates for the Lua.
- Packaging + API caveats: `memories/2026-06-14-hammerspoon-nix-darwin-packaging.md`.
