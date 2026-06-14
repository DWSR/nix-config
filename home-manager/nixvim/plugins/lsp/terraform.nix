_: {
  programs.nixvim.plugins.lsp.servers.terraformls.enable = true;
  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers.terraformls.activate = false;
}
