{ pkgs, ... }:
{
  programs.nixvim = {
    extraPlugins = [ pkgs.unstable.vimPlugins.nvim-lsp-file-operations ];

    extraConfigLuaPost = ''require("lsp-file-operations").setup()'';
  };
}
