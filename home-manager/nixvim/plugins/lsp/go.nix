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

      settings = {
        initialization_options = {
          command = [
            "golangci-lint"
            "run"
            "--output.json.path=stdout"
            "--show-stats=false"
            "--issues-exit-code=1"
          ];
        };
      };
    };
  };

  programs.nixvim.extraPackages = [ pkgs.unstable.golangci-lint ];
}
