{ pkgs, config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim = {
    extraPlugins = [pkgs.vimPlugins.nvim-lsp-file-operations];

    extraConfigLuaPost = ''require("lsp-file-operations").setup()'';
  };
}
