# Gap Analysis: hammerspoon-keybindings

## Scope
Framework-only spec: install Hammerspoon via Nix (no Homebrew) on both hosts, an
app-agnostic declarative keybinding Home Manager module, and verification. The
mic-toggle binding and Ears removal are owned by `ears-hammerspoon-migration`.

External-dependency research (version, artifact + hash, MIT license, nix-darwin
copy mechanism, TCC stability, config loading) is recorded in
`memories/2026-06-14-hammerspoon-nix-darwin-packaging.md`. This document maps the
requirements onto existing repo patterns. No `product.md`/`tech.md`/`structure.md`
steering exists; analysis relies on the brief, the packaging memory, and the
codebase.

## Current State (patterns to align with)
- **Overlays**: `custom-packages` merges sub-overlays (`overlays/default.nix:25-30`);
  `overlays/misc.nix` is the catch-all. No `.app` / `fetchzip` / `stdenvNoCC`
  precedent. Closest fetch+unpack+install is `chrome-devtools-mcp`
  (`overlays/mcp-servers.nix:556-581`): `fetchurl` + `dontBuild` + `installPhase` cp.
- **GUI app install today**: Homebrew casks only
  (`configurations/common-darwin/default.nix:209-218`). No `environment.systemPackages`
  in any real config; nix-darwin's `/Applications/Nix Apps` rsync copy is untouched
  and would copy a packaged `.app` to the fixed path.
- **HM module-with-options template**: `home-manager/mcp/default.nix` —
  `options.home.mcp` with `submodule`/`attrsOf` (`:319`,`:399-445`), file rendering
  via `xdg.configFile.<x>.text` (`:549-552`), launch via `launchd.agents.<name>`
  with `RunAtLoad` (`:561-604`), imported per-host
  (`configurations/{personal,shopify}/home-manager/default.nix`).
- **Config rendering**: `.text`/`.source` through `home.file`/`xdg.configFile`. Lua
  is already emitted by nixvim, including a standalone file via
  `extraFiles."lua/....lua".text` (`home-manager/nixvim/plugins/shadowenv.nix:69`).
  `stylua` is available (`home-manager/common/default.nix:103`); `luacheck` is NOT
  packaged anywhere.
- **flake checks**: Nix-eval assertions (`flake.nix:442-470`), package-build checks
  (`:682-690`), node tests under `tests/<feature>/` via `runCommand` (`:612-628`).
- **Shared HM wiring**: add a file to the `home-manager/common/default.nix` imports
  (`:8-83`) to reach both hosts. `environment.systemPackages` for both hosts belongs
  in the shared `configurations/common-darwin/default.nix` config block.
- **username + guards**: `username` via `specialArgs`/`extraSpecialArgs`
  (`flake.nix:941,951`; `common-darwin:105`). Pre-commit guards: no `builtins.fetch*`,
  no `/tmp/`, no literal `/Users/` (`flake.nix:862-885`); nixfmt-rfc-style + statix +
  deadnix must pass.

## Requirement-to-Asset Map
Gap tags: Missing (build new), Unknown (research), Constraint (existing limit).

| Req | Capability | Existing asset | Gap |
|-----|-----------|----------------|-----|
| R1.1-1.2 | install, no Homebrew, both hosts | overlay catch-all `misc.nix`; cask list shows both-host wiring | Missing: `.app` derivation (net-new). Constraint: no fetchzip/.app precedent |
| R1.3,1.4,1.6 | stable path, launcher-visible, in-place update | nix-darwin `/Applications/Nix Apps` rsync copy (default, untouched) | Constraint: first `environment.systemPackages` use. Unknown: activation-hang #1757 |
| R1.5 | TCC persists across rebuild | path + designated-requirement stability (memory-verified) | Unknown: possible re-grant on version bump (empirical) |
| R1.7 | launch at login | HM `launchd.agents` RunAtLoad (`mcp:561-604`); `hs.autoLaunch` | Missing: choose mechanism (design) |
| R1.8 | fetch/integrity failure is loud | `fetchzip` pinned sha256 | none |
| R2.1-2.3 | manual Accessibility grant, documented | macOS TCC; `ears.nix` manual precedent | Constraint: cannot be automated; doc only |
| R3.1-3.4 | schema, 3 action types, render, global firing | `home.mcp` submodule pattern; nixvim Lua emit; `home.file` | Missing: keybinding submodule + Lua generator |
| R3.5 | auto-reload after switch | none | Missing + Unknown: reload of a store-symlinked init.lua |
| R3.6 | empty set renders valid config | renderer handles `[]` | Missing: renderer edge case |
| R3.7-3.9 | duplicate / incomplete / invalid -> build fail | Nix-eval `assertMsg`/`throw`, types (`flake.nix:442`) | Missing: eval-time validation in the module |
| R4.1-4.4 | build + render + failure checks, no host needed | flake check patterns (`:612-690`); `tests/<feature>/` | Missing: hammerspoon checks. Constraint: no luacheck (stylua only) |

## Implementation Approach Options

### Option A: Extend existing files (minimal new files)
Add the `hammerspoon` derivation to `overlays/misc.nix`; add `environment.systemPackages`
and an inline `home.file` init.lua directly in `configurations/common-darwin/default.nix`
/ `home-manager/common/default.nix`.
- ✅ Fewest files; fast for a single hardcoded config.
- ❌ No reusable options schema; inlining a keybinding "framework" into shared files
  bloats them and gives the migration nothing clean to consume. Contradicts the
  framework boundary.

### Option B: New components (matches chosen architecture)
- Package: new `hammerspoon` attr in `overlays/misc.nix` (or a dedicated
  `overlays/hammerspoon.nix` if it grows).
- Install: one-line `environment.systemPackages = [ pkgs.hammerspoon ]` in
  `configurations/common-darwin/default.nix`.
- Framework: new `home-manager/common/hammerspoon-keybindings.nix` exposing
  `options.home.hammerspoon` (mirroring `home.mcp`), rendering `~/.hammerspoon/init.lua`
  via `home.file`, with eval-time validation; added to the common imports.
- Verification: new `tests/hammerspoon-keybindings/` + flake checks (package build,
  render assertion, eval-failure cases).
- ✅ Clean separation; reuses the `home.mcp` template; gives the migration a stable
  action-type contract; isolates the net-new packaging.
- ❌ More files; the options/Lua-generator interface needs careful design.

### Option C: Hybrid / phased (Option B end-state, de-risked)
Same target as B, sequenced: (1) package + systemPackages + minimal empty init.lua
to prove install + TCC + activation on a real host; (2) the options schema + Lua
generator + validations; (3) verification checks.
- ✅ Surfaces the net-new `.app` packaging and activation-hang #1757 before schema
  work; each phase is independently switchable.
- ❌ More planning; intermediate states ship a do-nothing Hammerspoon.

**Lean**: Option B as the structure, sequenced per Option C to de-risk packaging
first. Matches the chosen Approach 1 and the `home.mcp` precedent.

## Effort & Risk
- **`.app` packaging** (R1.1, R1.8): Effort S-M. Risk Medium — net-new pattern,
  fetchzip-vs-unzip caveat, signature/notarization must survive unpack+copy.
- **systemPackages install + Nix Apps copy** (R1.2-1.6): Effort S. Risk Medium —
  first `environment.systemPackages` use; App Management grant required; intermittent
  activation-hang #1757 on this exact path.
- **Keybinding HM module: options + Lua generator + validation** (R3): Effort M.
  Risk Medium — strong template, but Lua string-escaping and eval-time duplicate/
  invalid detection are new and correctness-sensitive.
- **Auto-reload + launch-at-login** (R1.7, R3.5): Effort S-M. Risk Medium — store
  symlink interacts awkwardly with pathwatcher and `hs` IPC.
- **Verification** (R4): Effort S. Risk Low — strong precedent; constrained to stylua
  + structural asserts (no luacheck).
- **Overall**: M (3-7 days). Risk Medium, dominated by net-new macOS `.app`
  packaging and TCC/activation behaviors that only fully verify on a real host.

## Recommendations for Design
- Adopt Option B structure, phased per Option C (packaging + bare install first).
- Settle the **action-type contract** carefully — it is the interface
  `ears-hammerspoon-migration` consumes: a binding = `{ mods, key, action }` where
  `action` is exactly one of `applescript` / `command` / `lua`. Mirror the
  `home.mcp` submodule style.
- Define **hotkey identity** (order-insensitive modifier set + key) for duplicate
  detection, and the accepted modifier/key vocabulary (must accept the migration's
  `ctrl+cmd+shift` + `F12`).
- Decide the **Lua generation + escaping** strategy: `hs.hotkey.bind` per binding;
  AppleScript via `hs.osascript`, command via `hs.execute`, `lua` inlined verbatim;
  safe quoting for payloads containing quotes/newlines.
- Decide **auto-reload** (pathwatcher on the resolved config path vs activation-time
  reload) and **launch-at-login** (HM `launchd.agents` vs login item), both robust to
  the read-only Nix Apps copy and the store-symlinked init.lua.
- Disable Sparkle in the generated config (the store copy is read-only; updates are
  Nix-managed).

## Research Needed (carry to design)
- R-1 Auto-reload of a store-symlinked `~/.hammerspoon/init.lua` after `switch`
  (does a pathwatcher fire on symlink-target change; what path to watch).
- R-2 Declarative launch-at-login that survives the read-only `/Applications/Nix Apps`
  copy (launchd agent invoking the bundle vs a login item).
- R-3 Lua escaping for AppleScript / CLI / inline-Lua action payloads (quotes,
  multiline, special chars) — correctness-critical for the contract.
- R-4 Modifier/key validation vocabulary + duplicate-hotkey identity, incl. F-key
  handling (the migration uses `ctrl+cmd+shift+F12`).
- R-5 Verifying rendered Lua without `luacheck` (stylua `--check` + structural string
  asserts; or add `luacheck` to the overlay).
- R-6 Confirm `fetchzip { stripRoot = false; }` yields an intact signed bundle at
  1.1.1 (vs `fetchurl` + manual `unzip` fallback); verify signature survives the copy.
- R-7 (operational) activation-hang #1757 exposure on these hosts at first switch.

---

# Design Phase: synthesis & decisions

## Summary
- **Feature**: hammerspoon-keybindings (framework-only)
- **Discovery Scope**: Extension (light). External deps already researched
  (packaging memory + gap analysis); this phase is integration + synthesis.
- **Key Findings**:
  - The `lua` action is the general case; AppleScript/CLI are renderer sugar. One
    pure renderer, three input shapes, plus an `extraConfig` escape hatch.
  - Validation must live in the pure renderer so eval-failure is testable via
    `nix eval` without a host.
  - `fetchurl` + `unzip` (known zip sha256) is preferred over `fetchzip` to keep a
    stable hash and a faithful signed bundle.

## Synthesis Outcomes
- **Generalization**: collapsed the three action types onto one binding→Lua
  renderer; added `extraConfig` as the maximal escape hatch (mirrors nixvim
  `extraConfigLua`) so consumers (the migration) add watchers/menubar without the
  framework knowing about them.
- **Build vs adopt**: adopt `hs.hotkey`, `hs.pathwatcher`, the nix-darwin Nix Apps
  copy, and `stylua`; build only the small renderer + derivation. Reject
  `mac-app-util` (TCC trampoline instability, issue #19) and `luacheck` (`hs`
  global false positives).
- **Simplification**: single `init.lua`, no Spoons, no `package` plumbing inside
  the HM module (the launchd agent targets the stable path), validation in-renderer.

## Design Decisions

### Decision: fetchurl + unzip over fetchzip (R-6)
- **Selected**: `pkgs.fetchurl` of the release zip (known sha256 `11bb1c90...`) +
  `unzip` + `cp`, with `dontFixup`/`dontStrip`.
- **Rationale**: stable known hash, faithful bundle bytes, signature preserved;
  matches the repo's fetchurl-only precedent.
- **Trade-offs / Follow-up**: fallback to `fetchzip { stripRoot = false; }` if a
  future bump requires it (hash form becomes a NAR hash).

### Decision: install via systemPackages, configure via HM (R-2)
- **Selected**: darwin `environment.systemPackages` (stable `/Applications/Nix Apps`
  path = TCC stability); launch-at-login via home-manager `launchd.agents`
  targeting `/Applications/Nix Apps/Hammerspoon.app/Contents/MacOS/Hammerspoon`,
  `RunAtLoad = true`.
- **Rejected**: `hs.autoLaunch(true)` (imperative, non-declarative); `mac-app-util`
  (TCC). Cross-layer path coupling is recorded as a Revalidation Trigger.

### Decision: auto-reload via in-config pathwatcher (R-1)
- **Selected**: the rendered `init.lua` starts `hs.pathwatcher` on `~/.hammerspoon/`
  calling `hs.reload()`; HM switch swaps the init.lua store symlink and FSEvents on
  the dir fires it. Gated by `reloadOnConfigChange` (default true).
- **Follow-up**: confirm the symlink swap fires the watcher on the first real host
  switch; fallback is manual `hs.reload()`/relaunch.

### Decision: validation in the pure renderer (R-3, R-4)
- **Selected**: the renderer `throw`s on duplicate/incomplete/invalid bindings;
  `escapeLua` (replaceStrings) escapes `command`/`applescript` payloads emitted as
  Lua string args to `hs.execute`/`hs.osascript`; inline `lua` is verbatim. Mods
  validated by `types.enum`; keys by a static allowlist (F1–F20, single chars,
  named keys) that includes F12.

### Decision: verify without luacheck (R-5)
- **Selected**: `nix eval` render assertions + expected-throw checks +
  `stylua --check`. No `luacheck` (it would false-flag the global `hs`).

## Risks & Mitigations
- nix-darwin activation hang #1757 on the Nix Apps path (R-7) — operational,
  intermittent; ensure App Management / Full Disk Access granted; not
  design-resolvable.
- TCC re-grant on occasional version bumps — accept; stable path + signing
  identity minimize it.
- Lua escaping correctness for arbitrary payloads — covered by unit tests on
  quotes/newlines.
- pathwatcher may not fire on a symlink swap in all cases — verify on first switch.

## References
- `memories/2026-06-14-hammerspoon-nix-darwin-packaging.md` — packaging, TCC, APIs, sources
- nix-darwin `modules/system/applications.nix`; issue #1757; hraban/mac-app-util
  #19/#36; Hammerspoon releases + docs (`hs.audiodevice`, `hs.pathwatcher`, `hs.ipc`)

---

# Gap Analysis Addendum: Requirement 5 (generated config validity)

## Scope of this addendum
Covers only the new R5 (derivation-time syntactic Lua + semantic Hammerspoon
validity). R1-R4 analysis above is unchanged. External research persisted to
`memories/2026-06-14-hammerspoon-init-lua-build-time-validation.md`.

## Current State (R5-relevant)
- `lua-language-server` is already a repo build input (`flake.nix:492`, nixvim
  integration check); `home-manager/nixvim/plugins/lsp/lua.nix` shows the settings
  shape (runtime.version, workspace.library, `checkThirdParty=false`, telemetry off).
- `stylua` is available but is a formatter (parses via full_moon); `stylua --check`
  conflates format drift with syntax, so it is not a clean syntax gate.
- `luac` / `lua5_4` are NOT in the repo today. `pkgs.lua5_4` provides `luac5.4`,
  matching Hammerspoon's bundled Lua 5.4.7.
- `luacheck` is NOT present and is shallow: it can only treat `hs` as a known
  global, not verify that `hs.audiodevice.defaultInputDevice` exists. Insufficient
  for R5.2/5.4.
- No Lua annotation generation exists. The package derivation fetches the bundle,
  which contains `Contents/Resources/docs.json` (the machine-readable `hs` API), so
  the API surface is on disk at build time.

## Requirement-to-Asset Map (R5)
| Req | Capability | Existing asset | Gap |
|-----|-----------|----------------|-----|
| 5.1, 5.3 | valid Lua; build fails on syntax error | `pkgs.lua5_4` `luac5.4` | Missing: add `pkgs.lua5_4`; wire `luac5.4 -p` |
| 5.2, 5.4 | semantically valid hs config; build fails on nonexistent symbol | bundle `docs.json`; `lua-language-server` | Missing: `hs` LuaCATS annotations + `.luarc.json` + check derivation |
| 5.5 | checks at derivation time, no host | repo build-input pattern | Constraint: LuaLS headless determinism (redirect HOME/metapath/logpath; `checkThirdParty=false`; force severities) |

## Implementation Options (semantic annotations — the crux of 5.2/5.4)
- **Option A — generate from the pinned bundle**: port the `EmmyLua.spoon`
  generator (Hammerspoon Spoons, MIT) to plain `lua5.4`, run it on
  `${hammerspoon}/…/Resources/docs.json` to emit `---@class hs.*` LuaCATS files.
  ✅ hermetic, auto-tracks the pinned HS version, satisfies 5.2/5.4. ❌ ~120-line
  port to maintain.
- **Option B — vendor pre-generated annotations** (fetchFromGitHub or commit
  generated output). ✅ simplest gate. ❌ manual refresh per HS bump; staleness; no
  maintained upstream addon (LLS-Addons has no `hs` entry).
- **Option C — `hs` as a defined global only** (no member checking). ✅ trivial.
  ❌ does NOT satisfy 5.2/5.4 (catches syntax + non-`hs` undefined globals only).
  Degraded fallback, non-compliant.

**Lean**: Option A (only option that satisfies 5.2/5.4 and tracks the pinned
version); B as a stopgap if the port slips.

## Tooling decisions
- **Syntax (5.1/5.3)**: `luac5.4 -p init.lua` from `pkgs.lua5_4` (exits 1 + stderr
  on error). Do not rely on `stylua` for syntax; keep `stylua` for formatting only.
- **Semantic (5.2/5.4)**: `lua-language-server --check ws --configpath .luarc.json
  --logpath <tmp> --metapath <tmp> --checklevel=Error`, with `HOME`/`XDG_CACHE_HOME`
  redirected, `.luarc.json` setting `runtime.version="Lua 5.4"`,
  `workspace.library=[<annotations>]`, `workspace.checkThirdParty=false`, and
  `diagnostics.severity.{undefined-field,undefined-global}="Error"`. Gate on exit
  code != 0 OR a non-empty `check.json`. Do NOT put `hs` in `diagnostics.globals`
  (that disables member checking). Gate scope: `undefined-field` /
  `undefined-global` only; avoid full type-mismatch checks (deep
  `device:method()` return-type coverage is good-not-perfect → false-failure risk).

## Design impact (supersedes prior decisions)
- Render `init.lua` through a **checked `runCommand`** (luac5.4 + lua-language-server)
  whose output is consumed as `home.file.".hammerspoon/init.lua".source`, so an
  invalid config fails the build of the config itself (not just `nix flake check`).
  This replaces the design's plain `home.file.text` rendering and the
  "reject luacheck / stylua-only" verification stance.
- New build pieces (additive to the design's File Structure Plan):
  - `pkgs.lua5_4` dependency; a `hammerspoon` annotations derivation that reads the
    pinned bundle's `docs.json` (Option A) — likely `pkgs.hammerspoon.passthru` or a
    sibling attr in `overlays/misc.nix`, plus the ported generator script.
  - the checked-render derivation in `home-manager/common/hammerspoon-keybindings/`.
  - `flake.nix` positive/negative R5 checks (valid config passes; a config using
    `hs.bogusModule.foo` fails the semantic gate).

## Effort & Risk (R5 increment)
- Syntax gate: S, Low.
- Annotation generator port (Option A): M, Medium (docs.json schema; nested-module
  classes; auto-tracks version).
- LuaLS check derivation + `.luarc.json`: M, Medium (headless determinism, severity
  tuning, false-positive avoidance).
- Overall R5 increment: M, Risk Medium.

## Research resolved / residual
- **Resolved** (prior R-5): LuaLS + EmmyLua-derived annotations is the path;
  `luacheck` rejected as *insufficient* (shallow), not merely false-positive-prone.
- **Residual**: the exact `EmmyLua.spoon` generator port (docs.json schema, nested
  modules); LuaLS deep return-type coverage (keep gate at undefined-field/global to
  avoid false failures); confirm the `luac5.4` binary name shipped by `pkgs.lua5_4`.

---

# Addendum: R6 (XDG config location) + correction

- **Correction**: the earlier claim (packaging memory + prior design/research) that
  `~/.hammerspoon/init.lua` is hardcoded and non-relocatable is WRONG. Current
  Hammerspoon reads the `MJConfigFile` user default at launch
  (`MJAppDelegate.m:217-218`) and relocates the entire config dir. The packaging
  memory `memories/2026-06-14-hammerspoon-nix-darwin-packaging.md` has been corrected.
- **Decision (R6)**: store the config at `$XDG_CONFIG_HOME/hammerspoon/init.lua` and
  set `MJConfigFile` to that absolute path so Hammerspoon loads it; leave nothing in
  `~/.hammerspoon`.
- **Design impact (for the re-run)**:
  - Deliver the validated config via `xdg.configFile."hammerspoon/init.lua".source`
    instead of `home.file.".hammerspoon/init.lua"`.
  - Set the `MJConfigFile` default to the absolute `$XDG_CONFIG_HOME/hammerspoon/init.lua`
    — e.g. home-manager `targets.darwin.defaults."org.hammerspoon.Hammerspoon".MJConfigFile`
    or nix-darwin `system.defaults.CustomUserPreferences."org.hammerspoon.Hammerspoon".MJConfigFile`.
  - The auto-reload pathwatcher must watch the XDG dir, not `~/.hammerspoon`;
    `hs.configdir`/`Spoons/` resolve under the XDG dir after relocation.
- Source: Hammerspoon `MJAppDelegate.m` (reads `MJConfigFile`), `variables.m`.

---

# Design Decision: validity gate placement (syntax on switch, semantic in CI)

- **Context**: R5 requires derivation-time syntactic + semantic validation. Design
  review flagged that wiring the semantic (`lua-language-server`) check into
  `xdg.configFile.source` would let an annotation-coverage gap block
  `darwin-rebuild switch`.
- **Decision (operator)**: the syntax check (`luac5.4 -p`) stays on the delivery
  path (blocks `switch` + CI; cheap and reliable). The semantic check
  (`lua-language-server` vs generated `hs` annotations) is a CI-only flake check
  (`hammerspoon-config-semantic`) that blocks `nix flake check` only, and MUST be
  hermetic.
- **Hermeticity**: offline (`checkThirdParty=false`, no addon fetch); redirected
  `HOME`/`XDG_CACHE_HOME`/`--logpath`/`--metapath`; annotations from the pinned store
  bundle; `aarch64-darwin`-gated. Deterministic, no network.
- **Requirement fit**: R5.3/5.4 ("a derivation-time check shall fail the build") hold
  — the semantic-check derivation fails to build on a bad `hs` reference; R5.5 (no
  host) holds for both. Realized as `checked-config.nix` (syntax, delivery) +
  `semantic-check.nix` (semantic, flake-check only).
