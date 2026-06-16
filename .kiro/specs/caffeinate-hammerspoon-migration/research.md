# Research & Gap Analysis: caffeinate-hammerspoon-migration

## Summary
- The `home.hammerspoon` framework and a working menu-bar consumer (`hammerspoon-mic-mute`) already exist and are enabled on both hosts; this feature is a near-clone of that consumer, minus the keybinding and the alert.
- All required Hammerspoon APIs are confirmed against the official docs; the only hard limitation is that `caffeinate -m` (disk-idle) has no `hs.caffeinate` equivalent.
- Caffeinate assertions are per-process (dropped on `hs.reload()`/quit), so the persisted-state requirement (R5) forces a re-assert-on-init pattern backed by `hs.settings`.
- Recommended approach: a new consumer module `home-manager/common/hammerspoon-caffeinate/` (Option B), mirroring `hammerspoon-mic-mute`. Effort S, Risk Low.

## Current-State Assets
- **Framework**: `home-manager/common/hammerspoon-keybindings/` — `default.nix` (`home.hammerspoon` options: `enable`, `keybindings`, `extraConfig`, `reloadOnConfigChange`; delivers syntax-gated `xdg.configFile."hammerspoon/init.lua"`, sets `MJConfigFile`, installs a login launchd agent), `render.nix` (emits `extraConfig` ahead of binds, then a reload watcher), `checked-config.nix` (`luac -p` syntax gate), `semantic-check.nix` (`mkSemanticCheck` = `lua-language-server` over `pkgs.hammerspoonHsAnnotations`).
- **Consumer precedent**: `home-manager/common/hammerspoon-mic-mute/{default.nix,mic-mute.lua}` — `default.nix` sets `home.hammerspoon.keybindings` + `extraConfig = builtins.readFile ./mic-mute.lua`; `mic-mute.lua` holds an `hs.menubar` handle in a plain upvalue, has an `updateMenubar()` painter, a global toggle, an `hs.audiodevice.watcher`, and an initial paint. It calls `hs.alert.show` (this feature must NOT).
- **Enablement**: `home-manager/common/default.nix` imports `./hammerspoon-keybindings` + `./hammerspoon-mic-mute` and sets `home.hammerspoon.enable = true` (shared by both hosts).
- **Package**: `overlays/misc.nix` `hammerspoon` (1.1.1) + `hammerspoonHsAnnotations` (LuaCATS from the bundle `docs.json`); generator `overlays/hammerspoon/gen-emmylua.lua`.
- **Flake checks** (`flake.nix`, aarch64-darwin `hammerspoonChecks`): `hammerspoon-config-semantic`, `hammerspoon-mic-mute-semantic` (feeds the LIVE `ShopifyLaptop` `home.hammerspoon` cfg into `mkSemanticCheck`), `hammerspoon-host-wiring`, `hammerspoon-mic-mute-wiring` (asserts the mic binding present + the `ears` cask absent). These are the templates for the caffeinate checks.
- **Removal targets**: `configurations/personal/default.nix:55` (`"domzilla-caffeine"` cask); `configurations/shopify/home-manager/zellij.nix:14,41-44` (the `caffeinate -dimsu` pane + its layout comment).

## External API Findings
Sources: hammerspoon.org/docs. Full detail + citations in `memories/2026-06-16-hs-caffeinate-menubar-settings-apis.md`.

- **`hs.caffeinate`** (`/docs/hs.caffeinate.html`): only three sleep types — `displayIdle` (prevent screen sleep; also prevents system idle-sleep), `systemIdle` (prevent system idle-sleep), `system` (prevent system sleep for any reason). `set(type, value, acAndBattery)`, `get(type) -> bool|nil`, `toggle(type) -> bool|nil`. `acAndBattery` applies only to `system` and is documented as non-functional under the Hardened Runtime HS now uses; `systemIdle`/`system` are honored on AC only. Assertions need no Accessibility grant (IOKit power assertions) and are **per-process** — the docs state sleep preventions are removed on `hs.reload()`.
- **`caffeinate -dimsu` mapping**: `-d`→`displayIdle`; `-i`→`systemIdle`; `-s`→`system` (AC-only in practice); `-u`→`hs.caffeinate.declareUserActivity()` (one-shot, not a sleep type); **`-m` (disk idle) → no equivalent (unavoidable gap)**.
- **`hs.menubar`** (`/docs/hs.menubar.html`): `new([inMenuBar],[autosaveName]) -> menubaritem or nil`. `setClickCallback(fn)` fires on click and — when no menu is attached — invokes the callback directly with no dropdown (docs: if a menu is attached the click callback is never called). `setTitle(string)` accepts an emoji/text indicator; `setTooltip(string)` for hover. Return type is `menubaritem or nil`, not an `hs.<module>` class, so the generated annotations carry no `---@return` for `hs.menubar.new` → object-handle rule applies.
- **`hs.settings`** (`/docs/hs.settings.html`): `set(key,val)` / `get(key)`; booleans supported; persisted in NSUserDefaults domain `org.hammerspoon.Hammerspoon`; survives `hs.reload()`, full restart, and logout-login.
- **Community pattern**: `Caffeine.spoon` (Chris Jones, MIT) — `hs.menubar.new` + `setClickCallback` + `hs.caffeinate.toggle("displayIdle")` + icon swap; no persistence, toggles only `displayIdle`.

## Requirement-to-Asset Map
| Req | Need | Asset | Gap |
|-----|------|-------|-----|
| R1 menu-bar toggle | `hs.menubar.new` + `setClickCallback` (no `setMenu`) | mic-mute menubar precedent (reuse) | click-to-toggle handler is new (mic-mute used a hotkey) — **Missing** (small) |
| R2 sleep prevention | `hs.caffeinate.set` displayIdle+systemIdle+system | none in repo | new code — **Missing**; `-m` disk-idle — **Constraint** (no API); `system` AC-only — **Constraint** |
| R3 indicator | `setTitle` emoji + `setTooltip` | mic-mute `updateMenubar` painter (reuse) | distinct on/off glyphs — **Missing** (trivial) |
| R4 silent | omit `hs.alert` | — | mic-mute alerts; must deliberately diverge — **Constraint** |
| R5 persistence | `hs.settings` boolean + re-assert on init | none in repo | per-process assertions force re-assert — **Missing** + **Constraint** |
| R6 removal | edit personal `default.nix` + shopify `zellij.nix` | ears-removal precedent (reuse) | two host edits — **Missing** (small) |
| R7 verification | `mkSemanticCheck` + host/wiring check pattern | `flake.nix` check templates (reuse) | new caffeinate-specific checks — **Missing** (small) |

## Implementation Approach Options
- **Option B — new consumer module (recommended)**: `home-manager/common/hammerspoon-caffeinate/{default.nix,caffeinate.lua}`, imported in `home-manager/common/default.nix`. `default.nix` sets only `home.hammerspoon.extraConfig = builtins.readFile ./caffeinate.lua` (no `keybindings`). Mirrors `hammerspoon-mic-mute` and the roadmap's per-app-migration module pattern. ✅ clean boundary, isolates the feature, matches precedent. ❌ one more module dir.
- **Option A — extend an existing file** (fold caffeinate into `mic-mute.lua` or framework `extraConfig`): ❌ violates the app-agnostic framework boundary, bloats an unrelated consumer, contradicts the roadmap split. Rejected.
- **Option C — hybrid/phased**: not applicable; no phasing needed for a single menu-bar item plus two removals.

## Effort & Risk
- **Effort: S** — one Lua file + one nix module + two host edits + flake checks, all cloned from an existing consumer.
- **Risk: Low** — framework proven, APIs confirmed against docs, object-handle rule and semantic-check behavior already documented; the only nuance (per-process assertions, `-m` gap) is understood up front.

## Recommendations for Design
- Adopt Option B. Consumer sets `extraConfig` only; `keybindings` stays `[]` (no global hotkey).
- On enable, assert `displayIdle` + `systemIdle` + `system`; on disable, clear all three. Document the `-m` disk-idle gap and the `system` AC-only caveat in design; they are honest deviations from literal `-dimsu`, already reflected in R2.
- Persist a boolean via `hs.settings` (e.g. key `caffeinate.enabled`); read on init defaulting to `false` (R5.5), apply assertions to match, paint the indicator; re-assert on every load (assertions do not survive reload/restart).
- Hold the `hs.menubar` handle in a plain `local` upvalue (object-handle rule); use `setClickCallback` with no `setMenu`; indicate state via distinct `setTitle` glyphs (and a tooltip).
- No `hs.alert`/notification anywhere in the toggle path (R4).

### Research Items to Carry Forward
- Confirm the semantic check (path-existence) passes for `hs.caffeinate.set/get/toggle`, `hs.menubar.new/setClickCallback/setTitle/setTooltip`, `hs.settings.set/get`; object methods on the untyped menubar handle pass only via the plain-upvalue rule.
- Decide the exact persistence key name and the two indicator glyphs in design.
- Mirror `hammerspoon-mic-mute-semantic` and `hammerspoon-mic-mute-wiring` as `caffeinate` flake checks: live-cfg semantic validity, menu-bar toggle present in both hosts' rendered config, `domzilla-caffeine` cask absent, `caffeinate -dimsu` zellij pane absent.
