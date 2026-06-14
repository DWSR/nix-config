_: {
  programs.nixvim.plugins.lsp.servers.markdown_oxide.enable = true;
  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers.markdown_oxide.activate = false;
}
