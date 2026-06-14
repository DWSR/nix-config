{ pkgs, ... }:
{
  programs.nixvim.plugins.lsp.servers.bashls.enable = true;
  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers.bashls.activate = false;

  programs.nixvim.extraPackages = [ pkgs.shfmt ];
}
