# Research & Gap Analysis: stylix-theming

Brownfield gap analysis plus external-dependency research. Findings only;
decisions belong in `design.md`.

## External findings (verified against upstream this session)

- **Release pin**: `release-26.05` branch exists and pins
  `nixpkgs = nixos-26.05`, matching this repo's channel. Correct pin:
  `stylix.url = "github:nix-community/stylix/release-26.05"` with
  `inputs.nixpkgs.follows = "nixpkgs"`. The 26.05 darwin module ships
  `darwinModules.stylix` and auto-wires HM targets.
- **Nord scheme path**: `pkgs.base16-schemes/share/themes/nord.yaml`
  (from `tinted-theming/schemes`). `base16Scheme` accepts that path.
- **Nord→base16 slot mapping** (exact, from `nord.yaml`):
  base00 #2E3440 (nord0), base01 #3B4252 (nord1), base02 #434C5E (nord2),
  base03 #4C566A (nord3), base04 #D8DEE9 (nord4), base05 #E5E9F0 (nord5),
  base06 #ECEFF4 (nord6), base07 #8FBCBB (nord7), base08 #BF616A (nord11),
  base09 #D08770 (nord12), base0A #EBCB8B (nord13), base0B #A3BE8C (nord14),
  base0C #88C0D0 (nord8), base0D #81A1C1 (nord9), base0E #B48EAD (nord15),
  base0F #5E81AC (nord10).
- **Off-palette colors with no exact base16 slot** (shade-shift caveats):
  `#616E88` (zjstatus `tab_normal` fg → nearest base03), `#000000`
  (Edgy `EdgyWinSeparator` fg → nearest base00 or keep literal), `#067a00`
  (delta `hunk-header-line-number-style` → nearest base0B green).
- **Target module behaviors** (from each `modules/<t>/hm.nix`):
  - bat: sets `programs.bat.config.theme = "base16-stylix"` itself.
  - fzf: sets `programs.fzf.colors`.
  - k9s: sets `programs.k9s.settings.ui.skin` + `skins.stylix`.
  - ghostty: sets `theme = "stylix"`, `font-family`, `font-size`
    (×4/3 on darwin), `background-opacity`.
  - starship: sets `palette = "base16"` + `palettes.base16` (named color
    keys: black, red, green, ..., plus base00..base17). Does NOT touch the
    format string or per-module styles.
  - zellij: defines `programs.zellij.themes.stylix` only; does NOT set
    `settings.theme`.
  - opencode: sets `programs.opencode.tui.theme = "stylix"` +
    `themes.stylix`.
  - nixvim (`stylix.targets.nixvim`): default plugin `mini.base16`
    (alt `base16-nvim`); enables the plugin, sets palette + guifont, and
    has `transparentBackground.{main,signColumn,numberLine}` options.
- **Darwin font flow**: `font-packages/darwin.nix` sets `fonts.packages`
  (nix-darwin system option) from `stylix.fonts.packages`. `fontconfig`
  target sets HM `fonts.fontconfig.defaultFonts` (largely inert on macOS).
  Per-app fonts arrive via each app target reading `fonts.monospace.name`,
  not via fontconfig.

## Requirement-to-asset map

| Req | Existing asset | Gap |
|---|---|---|
| 1 bootstrap | `flake.nix` inputs; `configurations/common-darwin/default.nix` module wiring | Missing: stylix input + darwin module import + `stylix.*` block. |
| 2 preserve | Nord everywhere; Monaspace in ghostty + `fonts.packages` | Constraint: base16 Nord ≈ named Nord except 3 off-palette colors. |
| 3 targets | `programs.{bat,fzf,k9s,ghostty,zellij,starship,opencode}` enabled; nixvim `colorschemes.nord` | Per-target enable + remove hand theming; zellij needs explicit `settings.theme`; opencode needs tui.json reconciliation. |
| 4 non-target | zjstatus KDL hex; `programs.delta.options`; starship style strings; nixvim `highlightOverride` | Rewrite to `config.lib.stylix.colors`; define slot mapping; handle 3 off-palette colors. |
| 5 fonts | `configurations/common-darwin/default.nix` `fonts.packages`; ghostty `font-family` | Set `stylix.fonts.monospace`; drop superseded wiring; keep Monaspace installed. |
| 6 cleanup | `inputs.color-schemes`; `home-manager/common/ghostty.nix` theme files | Remove input + files once unused. |
| 7 verify | `nix flake check`; nixvim test suite (`flake.nix` checks) | Each step must build both hosts + keep nixvim checks green. |

## Integration risks (carry to design)

- **OpenCode tui.json collision**: Stylix sets `programs.opencode.tui.theme`,
  which HM 26.05 renders to `opencode/tui.json`. The Shopify host writes that
  exact file via raw `xdg.configFile."opencode/tui.json"`. These collide.
  Design must move `scroll_acceleration` into `programs.opencode.tui` and drop
  the raw file. Personal host has no opencode theme today → it gains one.
- **Nixvim composition**: target injects `mini.nvim`/`base16-nvim` and sets the
  colorscheme. Repo uses `programs.nixvim` with `nixpkgs.pkgs = pkgs` and
  `performance.byteCompileLua`. Research Needed: confirm the target's plugin +
  `highlightOverride` compose with byte-compile and the existing Edgy/lualine
  highlights, and that the nixvim flake-check suite stays green.
- **autoEnable = false**: every target's `stylix.targets.<t>.enable = true`
  must be set explicitly; nothing themes implicitly.
- **Starship**: enabling the target swaps the palette to `base16`; the repo's
  `palette = "nord"` + all `nord*` style strings must be rewritten to base16
  names or the prompt references a removed palette (build/runtime breakage).
- **zellij theme selection**: target alone is inert without
  `settings.theme = "stylix"`.

## Implementation approach options

- **Option A — extend existing modules in place (recommended)**: add
  `stylix.*` to a small new common-darwin module; enable targets and strip
  theming within each program's existing `.nix` file. Fits the repo's
  per-program module layout; smallest blast radius per step; aligns with the
  staged-verification requirement.
- **Option B — new central theming module owning everything**: one module sets
  all `stylix.targets.*` and palette derivations. Fewer files touched but
  concentrates unrelated concerns and fights the repo's per-program layout.
- **Option C — hybrid**: central `stylix.*` core + per-program edits for target
  enable and non-target derivation. This is effectively Option A with the core
  block centralized; the natural fit.

## Effort / risk

- Effort: **M** (3–7 days equivalent): many small mechanical edits, one
  genuinely fiddly area (starship style rewrite + nixvim composition).
- Risk: **Medium**: bounded by `autoEnable = false` and per-step builds; main
  risks are the opencode tui.json collision and nixvim test-suite regression,
  both detectable by `nix flake check`.

## Research Needed (for design)

- Confirm `stylix.targets.nixvim` plugin choice (`mini.base16` vs
  `base16-nvim`) that least disturbs the existing byte-compiled nixvim, and
  whether `transparentBackground.main` reproduces the current
  `disable_background = true` look.
- Decide treatment of the 3 off-palette colors (#616E88, #000000, #067a00):
  snap to nearest base16 slot vs keep as literal override.
- Confirm whether the personal host should also drop any opencode theme
  defaults, since it currently sets none.
