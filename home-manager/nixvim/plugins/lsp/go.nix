{ pkgs, ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    gopls = {
      enable = true;
      autostart = false;
    };

    golangci_lint_ls = {
      enable = true;
      autostart = false;
    };
  };

  programs.nixvim.extraPackages = [pkgs.unstable.golangci-lint];
}
