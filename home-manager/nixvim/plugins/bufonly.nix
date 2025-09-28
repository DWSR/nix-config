{ pkgs, ... }:
{
  programs.nixvim = {
    extraPlugins = [
      pkgs.vimExtraPlugins.BufOnly-nvim
    ];

    keymaps = [
      {
        action = "<cmd>BufOnly<CR>";
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
