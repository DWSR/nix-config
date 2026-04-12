_: {
  programs.nixvim.plugins.treesitter-textobjects = {
    enable = true;

    select = {
      enable = true;
      lookahead = true;

      keymaps = {
        "af" = "@function.outer";
        "if" = "@function.inner";
        "ac" = "@class.outer";
        "ic" = "@class.inner";
        "aa" = "@parameter.outer";
        "ia" = "@parameter.inner";
      };
    };

    move = {
      enable = true;
      setJumps = true;

      gotoNextStart = {
        "]m" = "@function.outer";
        "]]" = "@class.outer";
      };

      gotoPreviousStart = {
        "[m" = "@function.outer";
        "[[" = "@class.outer";
      };
    };
  };
}
