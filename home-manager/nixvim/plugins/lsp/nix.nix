{ pkgs, ... }:
{
  programs.nixvim.extraPackages = [ pkgs.nixfmt ];

  programs.nixvim.plugins.lsp.servers.nixd = {
    enable = true;
    packageFallback = true;

    settings.formatting.command = [ "nixfmt" ];
  };
}
