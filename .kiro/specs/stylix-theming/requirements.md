# Requirements Document

## Introduction
This feature adopts Stylix as the single source of truth for colors and fonts
in this nix-darwin + Home Manager config and migrates every in-use
Stylix-supported program off its hand-written theming. The migration is
like-for-like: the visible result stays Nord with a Monaspace monospace font.
See `brief.md` for problem, approach, and scope rationale.

## Boundary Context
- **In scope**: Stylix bootstrap (flake input + nix-darwin module + core
  enable); Nord `base16Scheme`; Monaspace monospace font under `stylix.fonts`;
  migration of the supported targets in use (bat, fzf, k9s, ghostty, nixvim,
  zellij, starship, opencode, font packages/fontconfig); deriving non-target
  custom hex (zjstatus, delta, Starship layout styles, Nixvim Edgy overrides)
  from the Stylix palette; removal of superseded theming and the
  `color-schemes` flake input.
- **Out of scope**: changing away from Nord; light/dark auto-switching;
  wallpaper-generated palettes; theming programs that have neither current
  theming nor a Stylix target (chromium cask, Slack, Raycast, Hammerspoon,
  Deskflow, eza beyond current); macOS system-appearance/boot/login theming.
- **Adjacent expectations**: the Home Manager program modules already imported
  in minimal mode remain the integration surface; the OpenCode Shopify host
  config and the Nixvim modules are touched only at their theming seams; the
  unrelated opencode-cost roadmap is untouched.

## Requirements

### Requirement 1: Stylix bootstrap and core configuration
**Objective:** As the config maintainer, I want Stylix installed and centrally
configured, so that one place defines the scheme and fonts for all programs.

#### Acceptance Criteria
1. The configuration shall declare a Stylix flake input pinned to the
   release line matching the repo's nixpkgs/home-manager/nix-darwin channel
   (26.05).
2. The configuration shall import the Stylix nix-darwin module on both the
   personal and shopify hosts.
3. The configuration shall set `stylix.enable = true` and
   `stylix.autoEnable = false`.
4. The configuration shall set `stylix.base16Scheme` to a Nord scheme and
   `stylix.polarity = "dark"`.
5. While `stylix.autoEnable = false`, the configuration shall enable each
   Stylix target explicitly, and no supported target shall be themed unless it
   is explicitly enabled.
6. When the host configuration is built, `config.lib.stylix.colors` shall be
   available for use by non-target surfaces.

### Requirement 2: Appearance and behavior preservation
**Objective:** As the user, I want the migration to be like-for-like, so that
the terminal, editor, and tools look the same and keep working afterward.

#### Acceptance Criteria
1. The configuration shall keep the resolved color appearance Nord across all
   migrated programs.
2. The configuration shall keep Monaspace (MonaspiceNe Nerd Font Mono) as the
   monospace font in the terminal and editor.
3. While migrating a program, the configuration shall preserve that program's
   non-theme settings, including Ghostty keybinds and font-feature/style
   options, bat `style`, OpenCode `scroll_acceleration`, and Zellij layout and
   plugin configuration.
4. If a migrated program's resolved theme or font differs from the pre-
   migration appearance beyond the documented Nord-to-base16 slot mapping, the
   configuration shall be corrected before that step is considered complete.

### Requirement 3: Direct Stylix-target migration
**Objective:** As the config maintainer, I want each supported program routed
through its Stylix target, so that hand-written per-program theming is removed.

#### Acceptance Criteria
1. Where a Stylix target exists for an in-use program (bat, fzf, k9s, ghostty,
   nixvim, zellij, starship, opencode), the configuration shall enable that
   target.
2. When the bat target is enabled, the configuration shall remove the manual
   `theme = "Nord"` setting.
3. When the ghostty target is enabled, the configuration shall remove the
   copied Nord theme files and the manual `theme`, `font-family`, and
   `font-size` settings that Stylix now provides.
4. When the nixvim target is enabled, the configuration shall remove the
   manual `colorschemes.nord` block.
5. When the zellij target is enabled, the configuration shall select the
   Stylix-provided Zellij theme as the active theme.
6. When the opencode target is enabled, the configuration shall remove the
   manual `theme = "nord"` from the Shopify `tui.json` so the Stylix-managed
   TUI theme is authoritative on both hosts.
7. The configuration shall not leave any enabled program referencing a theme
   or palette name that no longer exists after migration.

### Requirement 4: Non-target palette derivation
**Objective:** As the config maintainer, I want custom-colored surfaces that
are not Stylix targets to derive from the Stylix palette, so that colors stay
unified with the scheme.

#### Acceptance Criteria
1. The configuration shall derive the zjstatus status-bar colors from
   `config.lib.stylix.colors` rather than hardcoded hex.
2. The configuration shall derive the delta git colors from
   `config.lib.stylix.colors` rather than hardcoded hex.
3. When the Starship target sets the base16 palette, the configuration shall
   replace `nord*` style references in the Starship format/module styles with
   the Stylix base16 palette color names so every style reference resolves.
4. The configuration shall derive the Nixvim Edgy highlight overrides from
   `config.lib.stylix.colors`, or remove them if the Stylix-themed defaults
   make them unnecessary.
5. The configuration shall define a documented Nord-to-base16 slot mapping that
   the converted non-target surfaces use consistently.

### Requirement 5: Font consolidation
**Objective:** As the config maintainer, I want fonts owned by Stylix, so that
font selection lives in one place alongside colors.

#### Acceptance Criteria
1. The configuration shall set `stylix.fonts.monospace` to the Monaspace Nerd
   Font package and name currently used.
2. The configuration shall leave `stylix.fonts.serif`, `sansSerif`, and `emoji`
   at Stylix defaults.
3. When Stylix owns fonts, the configuration shall remove font wiring that
   Stylix now supersedes (the Ghostty `font-family` and the duplicate font
   provisioning), while keeping any font package install still required for the
   chosen monospace font to be available.
4. The configuration shall ensure the Monaspace monospace font remains
   installed and resolvable after the ad-hoc font wiring is removed.

### Requirement 6: Cleanup of superseded configuration
**Objective:** As the config maintainer, I want dead theming removed, so that
the repo has no orphaned theme inputs or files.

#### Acceptance Criteria
1. When Ghostty no longer reads the vendored color-scheme files, the
   configuration shall remove the `color-schemes` flake input and its usages.
2. The configuration shall remove theme files, palette definitions, and
   per-program color settings that Stylix now provides.
3. If a removed input or file is still referenced anywhere, the configuration
   shall be corrected so no dangling reference remains.

### Requirement 7: Staged migration with verification
**Objective:** As the config maintainer, I want each step independently
verifiable, so that the migration can land incrementally without breakage.

#### Acceptance Criteria
1. The migration shall be ordered so that Stylix bootstrap lands before any
   target migration and target migrations land before final cleanup.
2. When any migration step is completed, `nix flake check` shall pass.
3. When any migration step is completed, both the personal and shopify host
   configurations shall build.
4. While migrating, each program's theming shall be changed in a step that can
   be built and reviewed independently of later steps.
5. If a step fails to build or breaks the Nixvim test suite, the configuration
   shall be fixed within that step before the next step begins.
