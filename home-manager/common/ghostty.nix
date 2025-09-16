{ inputs, lib, ... }:
{

  xdg.configFile = {
    "ghostty/themes/nord" = {
      enable = true;
      source = inputs.color-schemes + "/ghostty/nord";
    };

    "ghostty/themes/nord-wave" = {
      enable = true;
      source = inputs.color-schemes + "/ghostty/nord-wave";
    };
  };

  programs.ghostty = {
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
      window-decoration = "none";
    };
  };

}
