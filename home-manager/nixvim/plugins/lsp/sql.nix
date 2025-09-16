{ ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    sqlls = {
      enable = false;
      autostart = false;
    };
  };
}
