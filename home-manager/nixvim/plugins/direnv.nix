{ pkgs, ... }:
{
  programs.nixvim = {
    extraPlugins = [
      (
        pkgs.vimUtils.buildVimPlugin {
          name = "direnv-nvim";

          src = pkgs.fetchFromGitHub {
            owner = "actionshrimp";
            repo = "direnv.nvim";
            rev = "eec36a38285457c4e5dea2c6856329a9a20bd3a4";
            hash = "sha256-7NcVskgAurbIuEVIXxHvXZfYQBOEXLURGzllfVEQKNE=";
          };
        }
      )
      (
        pkgs.vimUtils.buildVimPlugin {
          name = "shadowenv-vim";

          src = pkgs.fetchFromGitHub {
            owner = "Shopify";
            repo = "shadowenv.vim";
            rev = "9c5a1da244ea869cff71075fba028904c6fc8f17";
            hash = "sha256-TtOjRYK0MQMQx7F3a63inqnX+4zje8k6eTPacNO0UmE=";
          };
        }
      )
    ];

    extraConfigLua = ''
      require("direnv-nvim").setup({
        async = true,
        on_direnv_finished = function()
          vim.api.nvim_call_function("shadowenv#hook", {})
          vim.cmd("LspStart")
        end
      })
    '';
  };
}
