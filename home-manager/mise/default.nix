{ pkgs, ... }:
{
  programs.mise = {
    enable = true;

    globalConfig = {
      settings = {
        activate_aggressive = true;
        experimental = true;
      };
    };
  };
}
