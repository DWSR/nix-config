{ config, ... }:
let
  helpers = config.lib.nixvim;
  # Select a textobject in operator-pending + visual modes (e.g. `daf`, `vif`).
  select = key: query: desc: {
    inherit key;
    mode = [
      "x"
      "o"
    ];
    action = helpers.mkRaw ''function() require("nvim-treesitter-textobjects.select").select_textobject("${query}", "textobjects") end'';
    options = {
      silent = true;
      inherit desc;
    };
  };
  # Move to a textobject (normal + visual + operator-pending). `fn` is the
  # nvim-treesitter-textobjects.move function (goto_next_start / goto_previous_start).
  move = fn: key: query: desc: {
    inherit key;
    mode = [
      "n"
      "x"
      "o"
    ];
    action = helpers.mkRaw ''function() require("nvim-treesitter-textobjects.move").${fn}("${query}", "textobjects") end'';
    options = {
      silent = true;
      inherit desc;
    };
  };
in
{
  programs.nixvim = {
    plugins.treesitter-textobjects.enable = true;

    # NOTE: nvim-treesitter-textobjects was rewritten for the main branch (the
    # nixvim/nixpkgs 26.05 default, same channel as nvim-treesitter). Textobject
    # keymaps are NO LONGER configured via
    # `require("nvim-treesitter.configs").setup({ textobjects = ... })`: the nixvim
    # module forwards `settings` into `plugins.treesitter.settings.textobjects`,
    # which the main branch IGNORES. Keymaps must be bound through Neovim's keymap
    # API calling `require("nvim-treesitter-textobjects.<module>")` (below), and
    # runtime options set via setup() — upstream defaults lookahead to false, so it
    # is restored here (set_jumps already defaults to true). A regression back to
    # the settings.* form is caught by tests/tier2-plugins.lua.
    extraConfigLuaPost = ''
      require("nvim-treesitter-textobjects").setup({
        select = { lookahead = true },
        move = { set_jumps = true },
      })
    '';

    keymaps = [
      (select "af" "@function.outer" "Select outer function")
      (select "if" "@function.inner" "Select inner function")
      (select "ac" "@class.outer" "Select outer class")
      (select "ic" "@class.inner" "Select inner class")
      (select "aa" "@parameter.outer" "Select outer parameter")
      (select "ia" "@parameter.inner" "Select inner parameter")
      (move "goto_next_start" "]m" "@function.outer" "Next function start")
      (move "goto_next_start" "]]" "@class.outer" "Next class start")
      (move "goto_previous_start" "[m" "@function.outer" "Previous function start")
      (move "goto_previous_start" "[[" "@class.outer" "Previous class start")
    ];
  };
}
