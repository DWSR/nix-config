{ pkgs, ... }:
{
  programs.nixvim = {
    extraPlugins = [
      (pkgs.vimUtils.buildVimPlugin {
        name = "direnv-nvim";

        src = pkgs.fetchFromGitHub {
          owner = "actionshrimp";
          repo = "direnv.nvim";
          rev = "eec36a38285457c4e5dea2c6856329a9a20bd3a4";
          hash = "sha256-7NcVskgAurbIuEVIXxHvXZfYQBOEXLURGzllfVEQKNE=";
        };
      })
    ];

    extraConfigLua = ''
      require("direnv-nvim").setup({
        async = true,
        on_direnv_finished = function()
          vim.cmd("LspStart")
        end
      })
    '';
  };
}
