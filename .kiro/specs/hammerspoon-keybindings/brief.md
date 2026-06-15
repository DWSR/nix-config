# Brief: hammerspoon-keybindings

## Problem
Global, app-targeting keybindings on macOS are managed per-app today, in opaque
preference formats. The Ears Insta-Mute hotkey
(`configurations/common-darwin/ears.nix`) is an `NSKeyedArchive` hex blob written
by an activation script: unreadable and unreviewable in a diff. There is no
declarative, reviewable way to define a global shortcut that runs an action.

## Current State
- No Hammerspoon install and no `.app`-via-Nix packaging precedent exist in the
  repo.
- Custom packages live in `overlays/`; per-user config generators are Home
  Manager modules (the `home.mcp` module is the closest template).
- Homebrew casks are declared in `configurations/common-darwin/default.nix`.

## Desired Outcome
Hammerspoon is installed declaratively (no Homebrew) on both hosts, and a Home
Manager options schema lets the operator declare global keybindings as
hotkey-to-action mappings that render into a readable Hammerspoon config. The
framework is app-agnostic: it knows nothing about microphones or Ears.

## Approach
Approach 1, a split of install and config:
- Package the signed Hammerspoon `.app` (release ~1.1.1) as a Nix derivation in
  `overlays/` via `stdenvNoCC.mkDerivation` + `pkgs.fetchzip { stripRoot = false; }`.
- Install it for the user through home-manager `home.packages` (linked into
  `~/Applications/Home Manager Apps`); nix-darwin's system `environment.systemPackages`
  / Nix Apps copy is intentionally not used. Tradeoff: TCC resolves to the store
  path, so the Accessibility grant is re-granted on a version bump.
- Expose a Home Manager module whose options describe keybindings, and deliver
  the syntax-validated config under `$XDG_CONFIG_HOME/hammerspoon/init.lua`.
- Action types stay generic: an AppleScript to run, a command-line invocation,
  and an inline-Lua / system escape hatch, so any system API can be invoked by a
  binding without the framework knowing about it.

This spec was split out of the original combined brief; the concrete mic-mute
binding and the Ears removal moved to `ears-hammerspoon-migration`. See
`.kiro/steering/roadmap-hammerspoon.md`.

## Scope
- **In**: Hammerspoon `.app` Nix package; nix-darwin install on both hosts;
  launch-at-login; first-run Accessibility documentation; the HM
  keybinding-options schema; generic action types (AppleScript / CLI /
  inline-Lua-or-system); `init.lua` generation; global hotkey firing; auto-reload
  on rebuild; duplicate/incomplete-binding validation; flake checks for the
  package build and config rendering, validated with test fixtures rather than a
  real binding.
- **Out**: the mic-mute toggle binding and its feedback (alert + menubar
  indicator); removal of Ears; macOS automation beyond keybindings (window
  management, app launchers, menubar widgets); bulk migration of other per-app
  shortcuts; automating the Accessibility grant; `mac-app-util`.

## Boundary Candidates
- `.app` packaging: overlay derivation, version pin, fetchzip hash.
- Install surface: home-manager `home.packages` (per-user; superseded the
  discovery-time nix-darwin `environment.systemPackages` candidate) + launch-at-login.
- Keybinding options schema + Lua code generation (the HM module).
- Generic action-type contract: AppleScript / CLI / inline-Lua-or-system.
- Verification: package-build + config-render flake checks.

## Out of Boundary
- Any audio/microphone behavior or the mic-mute binding.
- Ears removal (cask + `ears.nix`).
- Visual-feedback primitives tied to a specific binding (alert, menubar
  indicator).
- Window management, app launching, or other Hammerspoon Spoons.
- Declaratively granting Accessibility/TCC.

## Upstream / Downstream
- **Upstream**: home-manager `home.packages` + per-user app linking; home-manager
  `xdg.configFile`/`launchd.agents`; the `overlays/` custom-package pattern; both
  `darwinConfigurations` hosts.
- **Downstream**: `ears-hammerspoon-migration` is the first consumer (binds the
  mic toggle via the action-type contract); future keybindings reuse the schema.

## Existing Spec Touchpoints
- **Extends**: none.
- **Adjacent**: `ears-hammerspoon-migration` (downstream consumer; must not
  inherit audio concepts defined here). `personal-tailscale-service` and the
  `home.mcp` module are structural templates, not dependencies. Orthogonal to the
  cost-reduction `roadmap.md`.

## Constraints
- macOS / aarch64-darwin, both hosts (`ShopifyLaptop`, `Brandons-MacBook-Pro`).
- No Homebrew for Hammerspoon; declarative Nix install only.
- Pre-commit guards: no `builtins.fetch*` (use `pkgs.fetchzip`), no `/tmp/`
  paths, no hardcoded `/Users/` (use `${username}`).
- Hammerspoon's config path is relocatable via the `MJConfigFile` user default
  (read at launch), so the config lives under `$XDG_CONFIG_HOME/hammerspoon/init.lua`
  with nothing left in `~/.hammerspoon`. A read-only store symlink is fine.
- A one-time manual Accessibility grant is unavoidable.
- Watch-items (non-blocking): home-manager per-user app-linking failures surface in
  activation output. Verify the Accessibility (TCC) grant persists empirically on the
  first Hammerspoon version bump — TCC keys on the version-specific store path, so it
  re-grants on a bump.
- Packaging + viability detail: `memories/2026-06-14-hammerspoon-nix-darwin-packaging.md`.
