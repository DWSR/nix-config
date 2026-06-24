{ pkgs, ... }:
{
  programs.ghostty = {
    enable = true;
    package = if pkgs.stdenv.isDarwin then pkgs.ghostty-bin else pkgs.ghostty;
    installBatSyntax = true;
    installVimSyntax = true;

    settings = {
      font-style = "Medium";
      font-style-bold = "Bold";
      font-style-italic = "MediumItalic";
      font-style-bold-italic = "BoldItalic";
      font-feature = "+liga, +dlig, +calt, +ss01, +ss02, +ss03, +ss04, +ss05, +ss06, +ss07, +ss08";
      window-decoration = "none";
      macos-option-as-alt = true;
      keybind = [
        "clear"
        "super+a=select_all"
        "super+c=copy_to_clipboard"
        "super+v=paste_from_clipboard"
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
