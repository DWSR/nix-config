_: {
  programs.nixvim.plugins.lsp.servers = {
    rubocop = {
      enable = true;
      autostart = false;
      package = null;
      packageFallback = true;
    };
    ruby_lsp = {
      enable = true;
      autostart = false;
      package = null;
      packageFallback = true;
    };

    # TODO: Install Sorbet
    # sorbet = {
    #   enable = true;
    #   autostart = false;
    # };
  };
}
