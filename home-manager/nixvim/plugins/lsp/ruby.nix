_: {
  programs.nixvim.plugins.lsp.servers = {
    rubocop = {
      enable = true;
      package = null;
      packageFallback = true;
    };
    ruby_lsp = {
      enable = true;
      package = null;
      packageFallback = true;
    };

    # TODO: Install Sorbet
    # sorbet = {
    #   enable = true;
    # };
  };

  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers = {
    rubocop.activate = false;
    ruby_lsp.activate = false;
  };
}
