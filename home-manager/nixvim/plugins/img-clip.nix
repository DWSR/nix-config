{ pkgs, ... }:
{
  programs.nixvim = {
    plugins.img-clip.enable = true;
    extraPackages = [ pkgs.pngpaste ];
  };
}
