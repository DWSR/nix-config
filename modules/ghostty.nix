{ inputs, pkgs, lib, home-manager, ... }: {
  home-manager.users."brandonmcnama".xdg.configFile."ghostty/themes/nord" = {
    enable = true;
    source = inputs.color-schemes + "/ghostty/nord";
  };

  home-manager.users."brandonmcnama".xdg.configFile."ghostty/themes/nord-wave" = {
    enable = true;
    source = inputs.color-schemes + "/ghostty/nord-wave";
  };

  home-manager.users."brandonmcnama".programs.ghostty = {
    enable = true;

    # Install ghostty from brew because nixpkgs can't build it on Darwin
    package = lib.mkForce null;

    # Can't do this when installing ghostty from Brew
    # installVimSyntax = true;
    # installBatSyntax = true;

    settings = {
      theme = "nord-wave";
      font-family = "MonaspiceNe Nerd Font Mono";
      font-style = "Medium";
      font-style-bold = "Bold";
      font-style-italic = "MediumItalic";
      font-style-bold-italic = "BoldItalic";
      font-size = "14.0";
      font-feature = "+liga, +dlig, +calt, +ss01, +ss02, +ss03, +ss04, +ss05, +ss06, +ss07, +ss08";
    };
  };
}
