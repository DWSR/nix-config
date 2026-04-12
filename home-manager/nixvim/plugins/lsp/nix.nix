{ pkgs, ... }:
{
  programs.nixvim.extraPackages = [ pkgs.nixfmt-rfc-style ];

  programs.nixvim.plugins.lsp.servers.nixd = {
    enable = true;
    packageFallback = true;

    settings.formatting.command = [ "nixfmt" ];
  };
}
