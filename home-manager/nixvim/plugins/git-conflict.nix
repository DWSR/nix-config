{ pkgs, ... }:
{
  programs.nixvim.plugins.git-conflict = {
    enable = true;

    # akinsho/git-conflict.nvim is unmaintained (last release v2.1.0, 2024-11; last
    # commit 2024-12). It uses Neovim APIs deprecated or removed by 0.12. Patch them
    # in-place (mirrors the still-open upstream PRs #122 / #125, plus a utils.lua
    # vim.loop fix those PRs miss). --replace-fail makes a future nixpkgs bump that
    # drops any of these strings fail the build loudly instead of silently no-op'ing.
    #   * vim.diagnostic.{disable,enable}(bufnr) -> boolean API  (REMOVED in 0.12 -> hard error)
    #   * vim.highlight.priorities               -> vim.hl.priorities
    #   * vim.pretty_print                       -> vim.print
    #   * .git lookup: cwd-only                  -> vim.fs.find upward walk (PR #125)
    #   * vim.loop                               -> vim.uv
    package = pkgs.vimPlugins.git-conflict-nvim.overrideAttrs (old: {
      postPatch = (old.postPatch or "") + ''
        substituteInPlace lua/git-conflict.lua \
          --replace-fail 'vim.diagnostic.disable(bufnr)' 'vim.diagnostic.enable(false, { bufnr = bufnr })' \
          --replace-fail 'vim.diagnostic.enable(bufnr)' 'vim.diagnostic.enable(true, { bufnr = bufnr })' \
          --replace-fail 'vim.highlight.priorities.user' 'vim.hl.priorities.user' \
          --replace-fail 'vim.pretty_print(' 'vim.print(' \
          --replace-fail "local gitdir = fn.getcwd() .. sep .. '.git'" "local gitdir = vim.fs.find('.git', { upward = true, path = fn.getcwd() })[1]" \
          --replace-fail 'if not vim.loop.fs_stat(gitdir) or state.current_watcher_dir == fn.getcwd() then return end' 'if not gitdir or not vim.loop.fs_stat(gitdir) or state.current_watcher_dir == fn.getcwd() then return end' \
          --replace-fail 'vim.loop' 'vim.uv'
        substituteInPlace lua/git-conflict/utils.lua \
          --replace-fail 'vim.loop' 'vim.uv'
      '';
    });

    settings = {
      default_commands = true;
      default_mappings = true;
      disable_diagnostics = true;
      list_opener = "copen";

      highlights = {
        incoming = "DiffAdd";
        current = "DiffText";
      };
    };
  };
}
