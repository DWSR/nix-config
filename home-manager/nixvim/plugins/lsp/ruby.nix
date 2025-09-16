{ ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    rubocop = {
      enable = true;
      autostart = false;
    };
    ruby_lsp = {
      enable = true;
      autostart = false;
    };

    # TODO: Install Sorbet
    # sorbet = {
    #   enable = true;
    #   autostart = false;
    # };
  };
}
