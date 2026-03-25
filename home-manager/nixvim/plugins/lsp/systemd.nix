{ ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    systemd_ls = {
      enable = true;
      autostart = false;
      packageFallback = true;
    };
  };
}
