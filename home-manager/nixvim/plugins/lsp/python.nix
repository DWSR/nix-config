_: {
  programs.nixvim.plugins.lsp.servers = {
    ruff = {
      enable = true;
      autostart = false;
    };

    pyright = {
      enable = true;
      autostart = false;
    };
  };
}
