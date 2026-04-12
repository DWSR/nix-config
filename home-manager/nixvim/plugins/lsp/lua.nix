_: {
  programs.nixvim.plugins.lsp.servers = {
    lua_ls = {
      enable = true;
      autostart = false;
    };
  };
}
