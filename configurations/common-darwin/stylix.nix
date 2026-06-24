{ pkgs, ... }:
{
  # Stylix system core: the single system-level block that defines the Nord
  # scheme and the Monaspace monospace font for both hosts. `autoEnable = false`
  # means no program is themed implicitly; each target is enabled explicitly in
  # `home-manager/common/stylix.nix` (later tasks). serif/sansSerif/emoji are
  # intentionally left at Stylix defaults.
  stylix = {
    enable = true;
    autoEnable = false;
    polarity = "dark";
    base16Scheme = "${pkgs.base16-schemes}/share/themes/nord.yaml";

    fonts.monospace = {
      package = pkgs.nerd-fonts.monaspace;
      name = "MonaspiceNe Nerd Font Mono";
    };
  };
}
