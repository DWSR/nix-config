{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim = {
    plugins.illuminate.enable = true;

    keymaps = [
      {
        action = helpers.mkRaw "function() require('illuminate').goto_next_reference(true) end";
        key = "]r";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Next reference";
        };
      }
      {
        action = helpers.mkRaw "function() require('illuminate').goto_prev_reference(true) end";
        key = "[r";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Previous reference";
        };
      }
    ];
  };
}
