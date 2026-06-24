# Brief: stylix-theming

## Problem
Theming in this nix-darwin config is hand-maintained per program. Nord colors
and the Monaspace font are duplicated across Ghostty, bat, Nixvim, Zellij,
Starship, OpenCode, delta, and the zjstatus status bar, plus a vendored
`iTerm2-Color-Schemes` flake input for Ghostty. Changing the scheme means
editing many files and copied hex values by hand.

## Current State
Per-program theming today (verified this session):
- Ghostty: copied Nord theme files from `inputs.color-schemes`, `theme`,
  `font-family`, `font-size` (`home-manager/common/ghostty.nix`).
- bat: `theme = "Nord"` (`home-manager/common/default.nix`).
- Nixvim: `colorschemes.nord` + Edgy highlight overrides
  (`home-manager/nixvim/default.nix`).
- Zellij: `theme = "nord"` + hardcoded zjstatus hex (`home-manager/common/zellij.nix`).
- Starship: Nord palette + `nord*` style strings (`home-manager/common/starship.nix`).
- OpenCode: Shopify `tui.json` `theme = "nord"`
  (`configurations/shopify/home-manager/opencode.nix`).
- delta: hardcoded git colors (`home-manager/common/git.nix`).
- Fonts: Monaspace via Ghostty `font-family` + darwin `fonts.packages`
  (`configurations/common-darwin/default.nix`).
Stylix is not installed. No `stylix.*` options anywhere.

## Desired Outcome
Stylix owns colors and fonts as the single source of truth. Every
Stylix-supported program in use is themed by Stylix; non-target surfaces
(zjstatus, delta, Starship layout styles, Edgy overrides) derive their colors
from `config.lib.stylix.colors`. The visible look stays Nord and the
monospace font stays Monaspace. Changing the scheme later is a one-line edit.

## Approach
Staged, target-by-target migration with `stylix.enable = true` and
`stylix.autoEnable = false`, so each program is enabled explicitly and
reviewed before the next. Add the Stylix nix-darwin module (which sets up the
Home Manager targets), pin `base16Scheme` to Nord, set `fonts.monospace` to
Monaspace, then convert programs in dependency order: core enable → low-risk
CLI targets → Ghostty → Nixvim → Zellij → Starship → OpenCode → fonts
consolidation → non-target hex conversion → cleanup. Each conversion removes
the superseded hand-written theming and is validated by `nix flake check` /
build before moving on.

## Scope
- **In**:
  - Add Stylix flake input + `darwinModules.stylix`, pinned to the 26.05
    release line to match nixpkgs/home-manager/nix-darwin.
  - `stylix.enable = true`, `stylix.autoEnable = false`, `base16Scheme` = Nord,
    `polarity = "dark"`, `fonts.monospace` = Monaspace.
  - Enable and migrate Stylix targets in use: bat, fzf, k9s, ghostty, nixvim,
    zellij, starship, opencode, fonts (font-packages + fontconfig).
  - Convert non-target custom hex (zjstatus KDL, delta git colors, Starship
    style strings, Nixvim Edgy overrides) to derive from
    `config.lib.stylix.colors`.
  - Remove superseded theming, incl. the `color-schemes` flake input once
    Ghostty no longer uses it.
  - Preserve all non-theme settings (Ghostty keybinds + font features, bat
    `style`, OpenCode `scroll_acceleration`, Zellij layout/plugins).
- **Out**:
  - Switching away from Nord or introducing light/dark auto-switching.
  - Wallpaper-generated palettes.
  - Theming programs with no current config AND no Stylix target (eza beyond
    what exists; chromium cask; Slack; Raycast; Hammerspoon; Deskflow).
  - Any nix-darwin macOS-appearance theming Stylix cannot drive on darwin.
  - New cosmetic redesign; this is a like-for-like migration.

## Boundary Candidates
- Stylix bootstrap (flake input, module import, core enable + scheme + fonts).
- Direct-target migrations (one seam per program: bat, fzf, k9s, ghostty,
  nixvim, zellij, starship, opencode).
- Non-target palette derivation (zjstatus, delta, starship layout, Edgy).
- Font consolidation (Monaspace into stylix.fonts; retire ad-hoc font wiring).
- Cleanup (remove `color-schemes` input + dead theming).

## Out of Boundary
- The opencode-cost-reduction roadmap and its specs (unrelated project).
- The Nixvim plugin architecture / testing framework beyond the colorscheme seam.
- macOS system appearance, wallpaper, login/boot theming.

## Upstream / Downstream
- **Upstream**: nixpkgs/home-manager/nix-darwin 26.05; Stylix release-26.05;
  `base16-schemes` (Nord); existing Home Manager program modules already
  imported in minimal mode.
- **Downstream**: future scheme/font changes become one-line edits; any
  future themed program just enables its Stylix target.

## Existing Spec Touchpoints
- **Extends**: none.
- **Adjacent**: Nixvim modules (`home-manager/nixvim/*`), OpenCode Shopify
  host config — touched only at their theming seams.

## Constraints
- macOS-first, nix-darwin on both hosts (personal + shopify); declarative
  install only, no imperative steps.
- Stylix master is rolling-release; pin to release-26.05 to match the channel
  set and keep inputs in sync.
- Nord→base16 slot mapping is not identical to the named `nord0..15` palette;
  converted non-target surfaces may shift shades slightly. Design must define
  the slot mapping so the result stays visually Nord.
- Stylix's generic `qt` Home Manager target auto-enables only under NixOS, so
  it is irrelevant here; targets must be enabled explicitly given
  `autoEnable = false`.
- Verify each step with `nix flake check` / host build before proceeding.
