{ pkgs, ... }:
{
  programs.nixvim.plugins.lsp.servers = {
    gopls = {
      enable = true;
      packageFallback = true;
    };

    golangci_lint_ls = {
      enable = true;
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

  # Deferred: started by direnv.nvim once the project toolchain is on PATH.
  programs.nixvim.lsp.servers = {
    gopls.activate = false;
    golangci_lint_ls.activate = false;
  };

  programs.nixvim.extraPackages = [ pkgs.unstable.golangci-lint ];
}
