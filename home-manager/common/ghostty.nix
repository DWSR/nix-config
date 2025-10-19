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
    package = inputs.DimitarNestorov.legacyPackages.aarch64-darwin.ghostty;

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
      macos-option-as-alt = true;
      keybind = [
        "clear"
        "super+a=select_all"
        "super+c=copy_to_clipboard"
        "super+v=paste_from_clipboard"
        "super+a=select_all"
        "super+q=quit"
        "super+k=clear_screen"
        "super+enter=toggle_fullscreen"
        "super+zero=reset_font_size"
        "super+minus=decrease_font_size:1"
        "super+plus=increase_font_size:1"
        "super+equal=increase_font_size:1"
      ];
    };
  };
}
