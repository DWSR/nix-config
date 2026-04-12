_: {
  programs.nixvim.plugins.navic = {
    enable = true;

    settings = {
      lsp.autoAttach = true;
      highlight = true;
      separator = " > ";
    };
  };
}
