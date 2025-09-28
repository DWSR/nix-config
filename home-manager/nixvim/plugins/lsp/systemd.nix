{ ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    systemd_ls = {
      enable = false;
      autostart = false;
    };
  };
}
