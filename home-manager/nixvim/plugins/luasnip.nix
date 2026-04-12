_: {
  programs.nixvim.plugins = {
    luasnip = {
      enable = true;

      # Load VS Code-style snippets from friendly-snippets
      fromVscode = [ { } ];
    };

    friendly-snippets.enable = true;
    cmp_luasnip.enable = true;
  };
}
