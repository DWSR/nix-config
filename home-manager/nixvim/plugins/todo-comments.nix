{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim = {
    plugins.todo-comments.enable = true;

    keymaps = [
      {
        action = helpers.mkRaw "function() require('todo-comments').jump_next() end";
        key = "]t";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Next TODO comment";
        };
      }
      {
        action = helpers.mkRaw "function() require('todo-comments').jump_prev() end";
        key = "[t";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Previous TODO comment";
        };
      }
    ];
  };
}
