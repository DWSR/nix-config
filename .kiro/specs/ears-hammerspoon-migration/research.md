# Research & Gap Analysis

## Summary
- **Feature**: `ears-hammerspoon-migration`
- **Discovery Scope**: Extension (consumes the implemented `hammerspoon-keybindings`
  framework) plus a destructive removal (Ears cask + `ears.nix`).
- **Key Findings**:
  - The framework contract the migration needs is fully implemented and stable:
    `home.hammerspoon.{keybindings,extraConfig}`, a `lua` action inlined verbatim
    inside `hs.hotkey.bind(...)`, and `extraConfig` emitted before the binds. No
    framework change is required.
  - All Hammerspoon APIs the brief calls for exist in 1.1.1 (verified against the
    official docs): mute toggle, no-hardware-mute detection via return values,
    input-volume fallback, the system-level default-device watcher, alert, and
    menubar. The design must reference only these real symbols (the framework's
    semantic check enforces it).
  - Verification can validate the *live* host config (not a drifting fixture copy)
    by feeding each host's `home.hammerspoon` cfg through the framework's
    `mkSemanticCheck`, plus per-host eval assertions for the binding and the Ears
    removal. The full mic-mute API surface was EMPIRICALLY confirmed to pass that
    gate on aarch64-darwin, given one authoring rule: hold Hammerspoon object handles
    in plain upvalues, not `nil`-initialized table fields (the menubar false-positive
    below).
  - The work splits cleanly into a new HM module (binding + feedback Lua) and
    darwin-layer teardown edits (cask list + `ears.nix`), landed together.

## Current State Investigation

### Framework assets the migration consumes (all implemented, approved)
- `home-manager/common/hammerspoon-keybindings/default.nix` — `home.hammerspoon`
  options: `enable`, `keybindings` (list of `{mods,key,description,action}`),
  `extraConfig` (`types.lines`, "escape hatch for watchers, menubar items, helper
  functions"), `reloadOnConfigChange`. `enable = true` is set once in
  `home-manager/common/default.nix:163` (binding-free).
- `render.nix` — pure renderer. Section order: header (`hs.automaticallyCheckForUpdates(false)`,
  `hs.accessibilityState(true)`, accessibility comment) → `extraConfig` →
  `map renderBinding keybindings` → reload watcher. A `lua` action is inlined
  verbatim inside `hs.hotkey.bind(mods, key, function() <lua> end)`. Key allowlist
  includes `F1`-`F20`; mods enum is `cmd/ctrl/alt/shift`. Duplicate/arity/key
  validation `throw`s at eval.
- `checked-config.nix` — `luac5.4 -p` syntax gate; its `$out` IS the delivered
  `xdg.configFile."hammerspoon/init.lua".source`, so invalid Lua blocks
  `darwin-rebuild switch` automatically (covers the migration's Lua too).
- `semantic-check.nix` — `mkSemanticCheck { pkgs, lib }: cfg -> derivation`;
  hermetic `lua-language-server --check` against `hammerspoonHsAnnotations`
  (generated from the pinned bundle's `docs.json`). CI-only; runs on fixtures.
- `flake.nix` `hammerspoonChecks` (aarch64-darwin-gated) — `hammerspoon-package`,
  `hammerspoon-config-semantic` (positive), `hammerspoon-config-semantic-rejects-bogus`
  (negative), `hammerspoon-host-wiring` (per-host eval asserts over both
  `ShopifyLaptop` and `Brandons-MacBook-Pro`).
- `tests/hammerspoon-keybindings/fixtures.nix` — `validMulti` already models a
  `ctrl+cmd+shift+F12` "Toggle microphone mute" binding (stub `command` action).

### Teardown targets
- `configurations/common-darwin/default.nix:16` imports `./ears.nix`;
  `:209-218` `homebrew.casks` includes `"ears"`. `onActivation.cleanup = "zap"`
  uninstalls a dropped cask.
- `configurations/common-darwin/ears.nix` — an `earsShortcut` activation script
  writing the `NSKeyedArchive` blob via `defaults write com.clickontyler.Ears`,
  plus `CustomUserPreferences."com.clickontyler.Ears"`.

### Wiring / platform facts
- Only two host configs (`shopify`, `personal`), both `aarch64-darwin`; both import
  `home-manager/common`. There are no `nixosConfigurations`. So the shared common
  HM config is darwin-only in practice (it already carries unguarded darwin-only
  packages: `karabiner-elements`, `raycast`). A platform guard on the mic-mute
  module is therefore unnecessary for current hosts.

## Research Log

### Hammerspoon `hs.audiodevice` mute + fallback API (v1.1.1)
- **Sources**: hammerspoon.org/docs/hs.audiodevice.html, /hs.audiodevice.watcher.html.
- **Findings**:
  - `hs.audiodevice.defaultInputDevice() -> device or nil`.
  - `:inputMuted() -> bool or nil` (`nil` = device does not support muting).
  - `:setInputMuted(state) -> bool` (`false` = does not support muting). This
    boolean return is the no-hardware-mute detector — no separate capability query.
  - `:inputVolume() -> 0..100 or nil`; `:setInputVolume(0..100) -> bool`. Reading
    volume after zeroing returns 0, so the pre-mute level must be cached in Lua
    state, not re-read.
  - `:name() -> string or nil` (for alert/menubar text).
- **Implications**: toggle path = read logical state → `setInputMuted`; if it
  returns false (or `inputMuted()` is nil), use the volume fallback (cache
  `inputVolume()` then `setInputVolume(0)`; restore the cached level on unmute).

### Default-input-device change detection
- **Findings**: module-level `hs.audiodevice.watcher.setCallback(fn)` + `.start()`;
  `fn` receives one string. The relevant event is `"dIn "` (default input changed;
  trailing space, always four chars). Distinct from per-device `:watcherCallback`.
  This module-level watcher is a single shared callback for the whole system; the
  mic-mute feature is its only user (the framework's reload uses `hs.pathwatcher`).
- **Implications**: register one callback, filter on `"dIn "`, refresh the menubar
  indicator (and re-resolve the current default for the next toggle).

### Object retention (GC)
- **Findings**: the docs explicitly warn audiodevice/watcher objects are GC'd
  unless stored in a Lua reference. The same applies to the `hs.menubar` item.
- **Implications**: hold the menubar item and feature state in a module-local table
  captured by the bind closure and the watcher callback (both retained by HS), so
  neither is collected for the session.

## Requirement-to-Asset Map
| Requirement | Existing asset | Gap | Tag |
|-------------|----------------|-----|-----|
| 1 toggle ⌃⌘⇧F12 | renderer `lua` action + `hs.hotkey.bind`; `hs.audiodevice` API | author the binding + toggle Lua | Missing (new code) |
| 2 no-hw-mute fallback | `:setInputMuted`/`:inputVolume` return contract | author detect+fallback+restore Lua | Missing (new code) |
| 3 alert + menubar | `extraConfig`; `hs.alert`, `hs.menubar` | author feedback Lua; retain menubar | Missing (new code) |
| 4 default-device change | `hs.audiodevice.watcher` | author watcher callback; retain | Missing (new code) |
| 5 Ears removal | cask list + `ears.nix` import | delete cask entry, file, import | Missing (edit/delete) |
| 6 verification | `mkSemanticCheck`, host-wiring assert pattern | add semantic + wiring checks | Missing (new checks) |
| (inherited) inert-until-grant, XDG, auto-reload, syntax gate | framework | none — reused as-is | Constraint |

## Implementation Approach Options

### Option A — Declare binding inline in `home-manager/common/default.nix`
Set `home.hammerspoon.keybindings`/`extraConfig` next to the existing `enable`.
- ✅ Fewest files. ❌ Buries ~60 lines of mic-mute Lua in the 225-line catch-all
  common file; weak separation; harder to give the Lua its own `.lua` file.

### Option B — New HM module owning the binding + feedback Lua (recommended)
`home-manager/common/<mic-mute-module>/` with a `default.nix` that sets
`home.hammerspoon.keybindings` + `extraConfig = builtins.readFile ./mic-mute.lua`,
imported from `home-manager/common/default.nix`. Teardown stays in the darwin layer.
- ✅ Matches the repo's module-per-feature convention; the substantial Lua lives in
  a real, `stylua`-formattable `.lua` file; clean boundary vs the framework.
- ❌ One extra directory. Crosses two layers (HM module + darwin teardown), but that
  split is intrinsic (Ears lives in the nix-darwin layer).

### Option C — Hybrid
Option B for the binding plus the unavoidable darwin-layer teardown edits. In
practice B *is* C, because the teardown cannot live in the HM module.

## Effort & Risk
- **Effort: M (3-7 days equivalent)** — small surface, but the toggle/fallback/
  watcher/feedback Lua needs care, plus new flake checks and the destructive
  removal.
- **Risk: Low-Medium** — all APIs verified to exist; the syntax gate already covers
  the live Lua; the only behaviors not statically verifiable (actual mute, alert,
  menubar, device-switch) are runtime and validated by operator smoke (mirrors the
  framework's Manual Smoke). Medium aspect: the destructive Ears removal must land
  atomically with the binding so mic-mute is never absent on a switched host.

## Design Decisions (carry into design.md)
- **New HM module (Option B)** owns the binding + `extraConfig`; Lua in a dedicated
  `.lua` file read via `builtins.readFile`. The binding's `lua` action is a
  one-liner calling the toggle function defined in `extraConfig` (which renders
  before the binds — ordering is satisfied).
- **State machine in Lua**: a module-local table holds `{muted, fallbackActive,
  preMuteVolume, menubar}`; toggle prefers `setInputMuted`, falls back to volume on
  a false/nil return; unmute restores the cached level.
- **Verification validates the live config**: feed each host's `home.hammerspoon`
  cfg through `mkSemanticCheck` (real Lua, no fixture drift) and add per-host eval
  assertions that the ⌃⌘⇧F12 `lua` binding is present and that `ears` is gone from
  `homebrew.casks`. Reuse the aarch64-gated `hammerspoonChecks` block + host-wiring
  assert pattern.
- **Object-handle rule (EMPIRICALLY VERIFIED against current state)**: hold
  Hammerspoon object handles (the menubar) in plain locals/upvalues, never in a
  `nil`-initialized table field. Building `mkSemanticCheck` over a `state` table whose
  `menubar` field was `nil`-initialized FAILED with
  `init.lua:.. [Error] Undefined field 'setTitle'. (undefined-field)`; rewriting the
  menubar as `local micMenubar = hs.menubar.new()` made the same config pass
  ("Diagnosis completed, no problems found"). Mechanism below.

### Semantic-check coverage and the annotation `@return` gap (VERIFIED)
- **Context**: validate the design's R6.1 approach by building `mkSemanticCheck`
  (real gate) over the planned mic-mute API surface on aarch64-darwin.
- **Findings**:
  - 3-level submodule refs work: `hs.audiodevice.watcher.setCallback`/`.start` pass
    (the generator emits `hs.audiodevice.watcher = M`, registering the field chain).
  - `hs.menubar.new` and `hs.audiodevice.defaultInputDevice` carry NO `---@return`
    in the generated annotations (the `docs.json` def did not parse to an `hs.<x>`
    return), so their results are untyped. A plain local stays untyped → its method
    calls are not member-checked → pass. A `nil`-initialized table field makes LuaLS
    infer a concrete type that lacks the method → false-positive.
  - Contrast: `hs.pathwatcher.new` HAS `---@return hs.pathwatcher`, so `:start()` is
    checked and passes (this is why `validMulti`'s reload watcher passed).
- **Implications**: the semantic check's load-bearing coverage is `hs.*`
  module/submodule/function PATH existence (high value: catches `hs.bogus`,
  `hs.audiodevice.bogus`). Object-method existence is only checked for typed-return
  constructors. Keep object handles as plain upvalues so the gate is false-positive
  free. Fixing the generator to emit `@return` for `hs.menubar.new` is OUT OF
  BOUNDARY (framework-owned) and unnecessary given the object-handle rule.

## Risks & Mitigations
- GC of menubar/watcher → retain them in closure-captured module-local upvalues.
- Semantic-check false positive on object methods of untyped-return constructors
  (e.g. `hs.menubar.new`) when stored in a `nil`-initialized table field → mitigated
  by the verified object-handle rule (hold handles as plain upvalues). High-value
  `hs.X.Y` path existence is still enforced.
- Ears removal is destructive (`cleanup = "zap"`) → land removal + binding in one
  change; verify cask absence in a flake check (R5/R6).
- `flake.nix` and `home-manager/common/default.nix` are shared with the framework →
  the migration only ADDS attrs/imports, never edits framework checks or the
  framework module.

## References
- `memories/2026-06-14-hammerspoon-nix-darwin-packaging.md` — mic-mute API caveats,
  packaging.
- `memories/2026-06-15-hammerspoon-semantic-flake-check-negative-pattern.md`,
  `…-host-wiring-eval-assertions.md` — the flake-check patterns to reuse.
- hammerspoon.org/docs/hs.audiodevice.html, /hs.audiodevice.watcher.html,
  /hs.alert.html, /hs.menubar.html — API surface (v1.1.1).
- `.kiro/specs/hammerspoon-keybindings/{requirements,design}.md` — the framework
  contract and boundary.
