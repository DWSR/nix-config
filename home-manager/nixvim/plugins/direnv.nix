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
          -- nixvim (>= 26.05) drives LSP via Neovim's native vim.lsp.enable()
          -- API; nvim-lspconfig's ":LspStart" command is no longer registered.
          -- Servers are already enabled at startup, so re-fire FileType for any
          -- loaded, normal buffer that has no client yet to let them attach now
          -- that direnv has loaded the project toolchain onto PATH.
          for _, bufnr in ipairs(vim.api.nvim_list_bufs()) do
            if
              vim.api.nvim_buf_is_loaded(bufnr)
              and vim.bo[bufnr].buftype == ""
              and next(vim.lsp.get_clients({ bufnr = bufnr })) == nil
            then
              vim.api.nvim_exec_autocmds("FileType", { buffer = bufnr })
            end
          end
        end
      })
    '';
  };
}
