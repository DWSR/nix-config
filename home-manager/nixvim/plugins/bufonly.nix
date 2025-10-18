{ config, pkgs, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim = {
    extraPlugins = [
      pkgs.vimExtraPlugins.BufOnly-nvim
    ];

    keymaps = [
      {
        action = helpers.mkRaw ''
          function()
            require("BufOnly").BufOnly()
            vim.api.nvim_exec_autocmds("BufDelete", {})
          end
        '';
        key = "<leader>bC";

        options = {
          silent = true;
          noremap = true;
          desc = "Close Other Buffers";
        };
      }
    ];
  };
}
