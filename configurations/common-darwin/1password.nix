{ pkgs, ... }:
{

  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    package = pkgs.unstable._1password-gui;
  };

}
