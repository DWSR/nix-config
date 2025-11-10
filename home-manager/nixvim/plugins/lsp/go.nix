{ pkgs, ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    gopls = {
      enable = true;
      autostart = false;

      packageFallback = true;
    };

    golangci_lint_ls = {
      enable = true;
      autostart = false;

      packageFallback = true;
    };
  };

  programs.nixvim.extraPackages = [pkgs.unstable.golangci-lint];
}
