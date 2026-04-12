{ pkgs, ... }:
let
  tomlFormat = pkgs.formats.toml { };
  wishConfig = tomlFormat.generate "wish.zsh.toml" {
    features = {
      "alias.cd" = false;
      "alias.j" = false;
      "alias.ls" = false;
      wcd = true;
      worldjump = true;
      worldpath = false;
    };
  };
in
{
  xdg.configFile."wish.zsh.toml" = {
    enable = true;
    source = wishConfig;
  };
}
