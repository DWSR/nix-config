{ pkgs, ... }:
{
  programs.nixvim.plugins.lsp.servers.graphql = {
    enable = true;
    autostart = false;
    package = pkgs.graphql-language-service-cli;
  };
}
