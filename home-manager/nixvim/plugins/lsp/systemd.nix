_: {
  programs.nixvim.plugins.lsp.servers.systemd_ls = {
    enable = true;
    packageFallback = true;
  };
  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers.systemd_ls.activate = false;
}
