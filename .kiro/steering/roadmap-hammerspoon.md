# Roadmap: Hammerspoon keybindings

## Overview
Provide a declarative way to manage global macOS keybindings on both nix-darwin
hosts, backed by a Nix-packaged Hammerspoon, and use it to retire the opaque Ears
mute-shortcut blob. The work is split into a reusable, app-agnostic keybinding
framework and a concrete Ears-to-Hammerspoon migration that consumes it.

This initiative is orthogonal to the cost-reduction `roadmap.md` and is tracked
separately here, mirroring `roadmap-cavemem-integration.md`.

## Approach Decision
- **Chosen**: Split the original single `hammerspoon-keybindings` spec into a
  framework spec (install + declarative keybinding mechanism) and a migration
  spec (the mic mute binding plus Ears removal) that depends on it.
- **Why**: The framework is a reusable capability with no Ears coupling; the
  migration is one concrete binding plus a host-affecting destructive removal
  (uninstalling Ears, deleting the `NSKeyedArchive` blob). Isolating the removal
  risk from the install, and keeping the framework app-agnostic, yields two
  independently reviewable boundaries.
- **Rejected alternatives**:
  - **Single combined spec** (the original Path C brief): coupled a reusable
    framework to one specific app migration and bundled a destructive Ears
    removal with the first install.
  - **Framework owns audio/feedback helpers**: would pull mic-mute, alert, and
    menubar concepts into the supposedly app-agnostic framework.

## Scope
- **In**: Nix-packaged Hammerspoon install (no Homebrew, both hosts); a
  declarative keybinding framework with generic action types; the ⌃⌘⇧F12 mic
  mute toggle with alert + menubar indicator; removal of Ears.
- **Out**: macOS automation beyond keybindings (window management, app
  launchers); bulk migration of other per-app shortcuts; automating the
  Accessibility grant; Spotlight/Dock helpers such as `mac-app-util`.

## Constraints
- macOS / aarch64-darwin, both hosts (`ShopifyLaptop`, `Brandons-MacBook-Pro`).
- No Homebrew for Hammerspoon; declarative Nix install only.
- Pre-commit guards: no `builtins.fetch*` (use `pkgs.fetchzip`), no `/tmp/`
  paths, no hardcoded `/Users/` (use `${username}`).
- A one-time manual Accessibility grant is unavoidable.
- Packaging + viability detail: `memories/2026-06-14-hammerspoon-nix-darwin-packaging.md`.

## Boundary Strategy
- **Why this split**: The framework is app-agnostic and reusable for any future
  binding; the migration is a single vertical slice plus a destructive removal.
  Separating them keeps the framework free of audio/Ears concepts and isolates
  the Ears-uninstall risk.
- **Shared seams to watch**:
  - The framework's action-type contract (AppleScript / CLI / inline-Lua-or-
    system escape hatch) is the interface the migration's mic-mute binding
    consumes. Changes to that contract ripple into the migration.
  - The framework's generated-config location and auto-reload behavior must be
    settled before the migration binds a real hotkey against it.
  - Removing Ears and binding the mic toggle should land together so mic-mute is
    never absent on a switched host.

## Existing Spec Updates
- [ ] hammerspoon-keybindings -- narrow scope to install + the app-agnostic
  keybinding framework + verification; remove the mic-toggle binding and Ears
  removal (moved to ears-hammerspoon-migration). Re-run
  `/kiro-spec-requirements` to drop the Ears-specific requirements (current
  R4, R5). Dependencies: none.

## Direct Implementation Candidates
- (none)

## Specs (dependency order)
- [ ] ears-hammerspoon-migration -- the ⌃⌘⇧F12 mic mute toggle (default input
  device, no-hardware-mute fallback) with transient alert + menubar state
  indicator, plus removal of the Ears cask and the `ears.nix` blob.
  Dependencies: hammerspoon-keybindings.
- [ ] caffeinate-hammerspoon-migration -- a menu-bar-only caffeinate toggle
  (click to enable/disable; icon indicates state; no alert on toggle;
  `-dimsu`-equivalent assertions; state persisted across reloads), plus removal
  of the `domzilla-caffeine` cask (personal) and the `caffeinate -dimsu` zellij
  pane (Shopify). Sibling of ears-hammerspoon-migration; independent of it.
  Dependencies: hammerspoon-keybindings.
