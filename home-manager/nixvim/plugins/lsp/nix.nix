{ ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    nixd = {
      enable = true;
      packageFallback = true;
    };
  };
}
