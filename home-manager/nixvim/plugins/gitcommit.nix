{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim.autoCmd = [
    # Hide edgy sidebar when editing commit messages
    {
      event = "VimEnter";
      callback = helpers.mkRaw ''
        function()
          local bufname = vim.api.nvim_buf_get_name(0)
          if bufname:match("COMMIT_EDITMSG")
            or bufname:match("MERGE_MSG")
            or bufname:match("TAG_EDITMSG")
            or bufname:match("EDIT_DESCRIPTION")
          then
            pcall(function() require("edgy").close() end)
          end
        end
      '';
      desc = "Hide edgy sidebar when editing commit messages";
    }

    # Ensure COMMIT_EDITMSG always gets gitcommit filetype
    {
      event = [
        "BufRead"
        "BufNewFile"
      ];
      pattern = [
        "COMMIT_EDITMSG"
        "MERGE_MSG"
        "TAG_EDITMSG"
      ];
      callback = helpers.mkRaw ''
        function()
          vim.bo.filetype = "gitcommit"
        end
      '';
      desc = "Force gitcommit filetype for commit message files";
    }

    # Configure gitcommit buffers with visual aids
    {
      event = "FileType";
      pattern = "gitcommit";
      callback = helpers.mkRaw ''
        function()
          vim.opt_local.spell = true
          vim.opt_local.spelllang = "en_us"
          vim.opt_local.colorcolumn = "50,72"
          -- textwidth=72 is already set by neovim's built-in gitcommit ftplugin
        end
      '';
      desc = "Configure gitcommit: spell check, column guides at 50 (subject) and 72 (body)";
    }
  ];
}
