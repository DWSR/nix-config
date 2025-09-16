{ pkgs, ... }:
{
  programs.nixvim.plugins.lsp.servers.bashls = {
    enable = true;
    autostart = false;
  };

  programs.nixvim.extraPackages = [pkgs.shfmt];
}
