{ ... }:
{
  programs.nixvim.plugins.lsp.servers.graphql = {
    enable = true;
    autostart = false;
  };
}
