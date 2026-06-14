{
  pkgs,
  lib,
  config,
  ...
}:
let
  # Servers configured with `activate = false` (in plugins/lsp/*.nix) are NOT
  # enabled by nixvim at startup. direnv.nvim enables them from the callback
  # below, once direnv has loaded the project's devshell toolchain onto PATH —
  # so packageFallback servers (gopls, golangci_lint_ls, …) resolve the
  # project-pinned binary instead of nixvim's fallback. nixd has no
  # `activate = false`, so it keeps autostarting everywhere (no devshell dep).
  #
  # Read from the resolved `lsp.servers` (read-only): the `activate` markers
  # live in the per-language files, so this list stays in sync automatically.
  deferredServers = lib.filter (
    name:
    let
      server = config.programs.nixvim.lsp.servers.${name};
    in
    (server.enable or false) && ((server.activate or true) == false)
  ) (builtins.attrNames config.programs.nixvim.lsp.servers);

  # Lua array literal: { "bashls", "gopls", … } (single line, no interpolation
  # indentation hazards).
  deferredServersLua = lib.concatMapStringsSep ", " (name: ''"${name}"'') deferredServers;
in
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
          -- Enable the deferred LSP servers (activate = false) now that direnv
          -- has loaded the project toolchain onto PATH. nixvim 26.05 drives LSP
          -- via the native vim.lsp.enable() API; there is no :LspStart command.
          for _, name in ipairs({ ${deferredServersLua} }) do
            vim.lsp.enable(name)
          end
          -- Attach to buffers opened before direnv finished: vim.lsp.enable
          -- registers the FileType autocmd, so re-firing it starts the servers
          -- on already-open, client-less buffers.
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
