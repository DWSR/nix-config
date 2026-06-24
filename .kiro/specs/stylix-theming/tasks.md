# Implementation Plan

Sequential migration: each task builds on the prior one, edits the shared
`stylix.nix` enable surface, and is verified by `nix flake check` plus both
host builds before the next begins (7.1, 7.4). No tasks are parallel-safe.

- [ ] 1. Foundation: Stylix bootstrap and core configuration
- [x] 1.1 Add the Stylix flake input and import the darwin module
  - Add a `stylix` flake input pinned to `release-26.05` with
    `inputs.nixpkgs.follows = "nixpkgs"`.
  - Import `inputs.stylix.darwinModules.stylix` in the shared common-darwin
    module so both hosts receive it.
  - Observable: `nix flake check` passes and both host configurations build
    with the Stylix module imported and Stylix still disabled (no appearance
    change).
  - _Requirements: 1.1, 1.2_
  - _Boundary: flake.nix, configurations/common-darwin/default.nix_

- [ ] 1.2 Configure the Stylix core and verify Home Manager integration
  - Set `stylix.enable = true`, `stylix.autoEnable = false`,
    `stylix.polarity = "dark"`, `stylix.base16Scheme` to the Nord scheme, and
    `stylix.fonts.monospace` to the Monaspace Nerd Font package and name.
  - Verify `config.lib.stylix.colors` and `stylix.targets.*` resolve in Home
    Manager scope; if darwin auto-import does not fire under minimal mode,
    import `inputs.stylix.homeModules.stylix` explicitly and set the same core
    there. This integration decision is made once here.
  - Observable: both hosts build; a trivial HM reference to
    `config.lib.stylix.colors` evaluates; no program appearance changes yet
    because no target is enabled.
  - _Requirements: 1.3, 1.4, 1.5, 1.6, 2.2, 5.1, 5.2_
  - _Boundary: configurations/common-darwin/stylix.nix, home-manager/common/stylix.nix_
  - _Depends: 1.1_

- [ ] 2. Core: low-risk CLI targets
- [ ] 2.1 Migrate bat to its Stylix target
  - Enable `stylix.targets.bat`; remove the manual `theme = "Nord"` while
    keeping the `style` setting.
  - Observable: bat resolves the Stylix `base16-stylix` theme, `style` is
    unchanged, and both hosts build.
  - _Requirements: 3.1, 3.2, 2.3_
  - _Boundary: home-manager/common/stylix.nix, home-manager/common/default.nix_
  - _Depends: 1.2_

- [ ] 2.2 Enable the fzf and k9s targets
  - Enable `stylix.targets.fzf` and `stylix.targets.k9s`.
  - Observable: fzf colors and the k9s skin are Stylix-provided and both hosts
    build.
  - _Requirements: 3.1_
  - _Boundary: home-manager/common/stylix.nix_

- [ ] 3. Core: Ghostty
- [ ] 3.1 Migrate Ghostty to its Stylix target
  - Enable `stylix.targets.ghostty`; remove the two copied Nord theme-file
    entries and the manual `theme`, `font-family`, and `font-size` settings;
    keep keybinds, font styles, and font-feature settings.
  - Observable: Ghostty renders Nord and uses Monaspace via Stylix, keybinds
    and font features are intact, and both hosts build.
  - _Requirements: 3.1, 3.3, 2.1, 2.3, 5.3_
  - _Boundary: home-manager/common/stylix.nix, home-manager/common/ghostty.nix_

- [ ] 4. Core: Nixvim
- [ ] 4.1 Migrate Nixvim to its Stylix target
  - Enable `stylix.targets.nixvim` with `plugin = "base16-nvim"` and
    `transparentBackground.main = true`; remove the manual `colorschemes.nord`
    block.
  - Observable: Neovim loads the Stylix base16 Nord colorscheme with a
    transparent background, the Nixvim flake-check suite stays green, and both
    hosts build.
  - _Requirements: 3.1, 3.4, 2.1, 7.5_
  - _Boundary: home-manager/common/stylix.nix, home-manager/nixvim/default.nix_

- [ ] 4.2 Derive the Edgy highlight overrides from the Stylix palette
  - Rewrite `highlightOverride.EdgyWinBar` and `EdgyWinSeparator` to
    `config.lib.stylix.colors` values per the documented slot mapping
    (separator fg → base00).
  - Observable: Edgy winbar/separator highlights resolve from the palette, the
    Nixvim suite stays green, and both hosts build.
  - _Requirements: 4.4, 7.5_
  - _Boundary: home-manager/nixvim/default.nix_
  - _Depends: 4.1_

- [ ] 5. Core: Zellij
- [ ] 5.1 Enable the Zellij target and select the Stylix theme
  - Enable `stylix.targets.zellij` and set
    `programs.zellij.settings.theme = "stylix"` (replacing `"nord"`).
  - Observable: Zellij's built-in UI (tabs, frames) uses the Stylix theme and
    both hosts build.
  - _Requirements: 3.1, 3.5_
  - _Boundary: home-manager/common/stylix.nix, home-manager/common/zellij.nix_

- [ ] 5.2 Derive the zjstatus status-bar colors from the palette
  - Replace the hardcoded zjstatus KDL hex with `let` bindings bound to
    `config.lib.stylix.colors.withHashtag` per the slot mapping, snapping the
    off-palette `#616E88` to base03.
  - Observable: the zjstatus bar foreground/background colors resolve from the
    palette and both hosts build.
  - _Requirements: 4.1, 4.5_
  - _Boundary: home-manager/common/zellij.nix_
  - _Depends: 5.1_

- [ ] 6. Core: Starship
- [ ] 6.1 Migrate Starship to the base16 palette and rewrite style references
  - Enable `stylix.targets.starship`; remove the local `nord` palette and
    `palette = "nord"`; rewrite every `nord*` token in the format string and
    per-module styles to the Stylix base16 palette color names.
  - Observable: the Starship prompt renders with the base16 palette, no
    `nord*` palette references remain, and both hosts build.
  - _Requirements: 3.1, 4.3, 3.7_
  - _Boundary: home-manager/common/stylix.nix, home-manager/common/starship.nix_

- [ ] 7. Core: OpenCode
- [ ] 7.1 Enable the OpenCode target and reconcile the Shopify TUI config
  - Enable `stylix.targets.opencode`; remove the raw
    `xdg.configFile."opencode/tui.json"` on the Shopify host and set
    `programs.opencode.tui.scroll_acceleration.enabled = true` so the
    Stylix-managed TUI theme is authoritative on both hosts.
  - Observable: the OpenCode TUI uses the Stylix theme on both hosts, the
    Shopify scroll-acceleration setting is preserved, there is no `tui.json`
    file collision, and both hosts build.
  - _Requirements: 3.1, 3.6, 2.3_
  - _Boundary: home-manager/common/stylix.nix, configurations/shopify/home-manager/opencode.nix_

- [ ] 8. Fonts consolidation
- [ ] 8.1 Move font ownership to Stylix and retire ad-hoc font wiring
  - Enable the Stylix `font-packages` target so `stylix.fonts.packages`
    installs fonts via `fonts.packages`; remove the manual
    `fonts.packages` list; confirm `nerd-fonts.monaspace` resolves
    "MonaspiceNe Nerd Font Mono" and decide explicitly whether the non-nerd
    `monaspace` package is still required before dropping it.
  - Observable: Monaspace is installed through Stylix, the monospace font name
    still resolves in the terminal and editor, and both hosts build.
  - _Requirements: 5.1, 5.3, 5.4_
  - _Boundary: configurations/common-darwin/stylix.nix, configurations/common-darwin/default.nix_

- [ ] 9. Non-target: delta
- [ ] 9.1 Derive the delta git colors from the Stylix palette
  - Rewrite `programs.delta.options` colors to `config.lib.stylix.colors`
    values per the slot mapping, snapping the off-palette `#067a00` to base0B;
    keep all non-color delta options.
  - Observable: a `git diff` through delta renders with palette-derived colors
    and both hosts build.
  - _Requirements: 4.2, 4.5_
  - _Boundary: home-manager/common/git.nix_

- [ ] 10. Cleanup
- [ ] 10.1 Remove the color-schemes input and remaining dead theming
  - Remove the `color-schemes` flake input and confirm no module references
    it; remove any leftover theme files, palette definitions, or per-program
    color settings that Stylix now provides.
  - Observable: `nix flake check` passes, there are no `inputs.color-schemes`
    references, and no migrated module references a removed theme or palette
    name.
  - _Requirements: 6.1, 6.2, 6.3, 3.7_
  - _Boundary: flake.nix, home-manager/common/ghostty.nix_

- [ ] 11. Validation
- [ ] 11.1 Verify the full migration across both hosts
  - Run `nix flake check`; build both `darwinConfigurations` (personal and
    shopify); confirm the Nixvim flake-check suite is green; scan migrated
    modules for any remaining `nord`-named palette/theme references and any
    `color-schemes` usage; spot-check that each migrated program (Ghostty,
    bat, k9s, Zellij/zjstatus, Starship, OpenCode, Nixvim) renders Nord and
    uses Monaspace, accepting only the documented off-palette shade snaps.
  - Observable: both hosts build, all checks pass, the reference scan is
    clean, and the appearance checklist matches the pre-migration Nord look
    within the documented slot mapping.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 2.1, 2.4_
  - _Depends: 1.1, 1.2, 2.1, 2.2, 3.1, 4.1, 4.2, 5.1, 5.2, 6.1, 7.1, 8.1, 9.1, 10.1_
