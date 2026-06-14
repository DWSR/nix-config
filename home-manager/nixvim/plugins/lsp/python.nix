_: {
  programs.nixvim.plugins.lsp.servers = {
    ruff.enable = true;
    pyright.enable = true;
  };

  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers = {
    ruff.activate = false;
    pyright.activate = false;
  };
}
