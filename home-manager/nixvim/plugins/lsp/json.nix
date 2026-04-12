_: {
  programs.nixvim.plugins.lsp.servers = {
    jqls = {
      enable = true;
      autostart = false;
    };

    jsonls = {
      enable = true;
      autostart = false;
    };
  };
}
