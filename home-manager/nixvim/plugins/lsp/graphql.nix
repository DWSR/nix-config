{ pkgs, ... }:
{
  programs.nixvim.plugins.lsp.servers.graphql = {
    enable = true;
    package = pkgs.graphql-language-service-cli;
  };
  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers.graphql.activate = false;
}
