# Stylix Home Manager scope.
#
# The system core (enable, autoEnable=false, polarity, base16Scheme, fonts) is
# set once in `configurations/common-darwin/stylix.nix` and propagated into HM
# via Stylix's darwin->HM integration. Per-target `stylix.targets.*` enables and
# the non-target palette derivations live here in later tasks (2.1+); none are
# set yet, so no program is themed by this file today.
#
# Nord -> base16 slot mapping (canonical, verified from nord.yaml).
# Non-target conversions reference this mapping;
# `config.lib.stylix.colors.withHashtag.base0X` yields the `#`-prefixed value.
#
#   | Named (current) | base16 | Hex     |
#   |-----------------|--------|---------|
#   | nord0           | base00 | #2E3440 |
#   | nord1           | base01 | #3B4252 |
#   | nord2           | base02 | #434C5E |
#   | nord3           | base03 | #4C566A |
#   | nord4           | base04 | #D8DEE9 |
#   | nord8           | base0C | #88C0D0 |
#   | nord11          | base08 | #BF616A |
#   | nord13          | base0A | #EBCB8B |
#   | nord14          | base0B | #A3BE8C |
#
# Off-palette colors (no exact base16 slot) snap to the nearest slot; this is
# the documented, intentional shade shift (satisfies 2.4, 4.5):
#   - #616E88 (zjstatus `tab_normal` fg)            -> base03
#   - #000000 (Edgy `EdgyWinSeparator` fg)          -> base00
#   - #067a00 (delta `hunk-header-line-number-style`) -> base0B
{ lib, ... }:
{
  # Sink Stylix's autoloaded HM targets for programs not imported under
  # `home-manager.minimal = true`: each target emits a `mkIf false` def for
  # undeclared `programs.<name>` options (alacritty, foot, …), which still trips
  # the module system's unmatched-definition check. Disabling the check drops
  # those inert defs, while the targets we explicitly enable (whose program
  # modules ARE imported) apply normally. mkForce overrides HM pkgsModule's
  # `_module.check = true`. See design.md Migration Strategy "Integration gate".
  _module.check = lib.mkForce false;
}
