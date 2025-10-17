{ pkgs, ... }:
{
  programs.nixvim = {
    extraPlugins = [pkgs.vimPlugins.nvim-lsp-file-operations];

    extraConfigLuaPost = ''require("lsp-file-operations").setup()'';
  };
}
