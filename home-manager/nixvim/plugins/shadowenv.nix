{
  config,
  lib,
  pkgs,
  ...
}:
{
  options.nixvim-extra.shadowenv.enable = lib.mkEnableOption "shadowenv.vim integration";

  config = lib.mkIf config.nixvim-extra.shadowenv.enable {
    programs.nixvim.extraPlugins = [ pkgs.shadowenv-vim ];

    programs.nixvim.autoGroups."shadowenv_bufenter" = {
      clear = true;
    };
    programs.nixvim.autoCmd = [
      {
        event = "BufEnter";
        group = "shadowenv_bufenter";
        desc = "Switch shadowenv to match buffer directory";
        callback.__raw = ''
          function()
            local buf_path = vim.api.nvim_buf_get_name(0)
            if buf_path == "" then return end
            local buf_dir = vim.fn.fnamemodify(buf_path, ":h")
            if vim.fn.isdirectory(buf_dir) == 0 then return end

            -- Walk up from buffer dir to find .shadowenv.d
            local dir = buf_dir
            while true do
              if vim.fn.isdirectory(dir .. "/.shadowenv.d") == 1 then
                break
              end
              local parent = vim.fn.fnamemodify(dir, ":h")
              if parent == dir then
                dir = nil
                break
              end
              dir = parent
            end

            if not dir then return end

            local win_cwd = vim.fn.getcwd(0)
            if dir == win_cwd then return end

            -- Use cd (not lcd) so the process cwd changes, which is what
            -- shadowenv hook --porcelain reads
            vim.cmd("cd " .. vim.fn.fnameescape(dir))

            -- Explicitly fire the hook since DirChanged may not re-trigger
            -- if shadowenv.vim already processed this event
            vim.fn["shadowenv#hook"]()

            -- Restart LSP clients whose root_dir doesn't contain this buffer
            vim.schedule(function()
              local bufnr = vim.api.nvim_get_current_buf()
              for _, client in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
                if client.root_dir and not vim.startswith(buf_path, client.root_dir) then
                  vim.lsp.stop_client(client.id)
                end
              end
            end)
          end
        '';
      }
    ];

    programs.nixvim.extraFiles."lua/shadowenv/health.lua".text = ''
      local M = {}

      function M.check()
        local health = vim.health

        health.start("shadowenv.vim")

        if vim.fn.exists("*shadowenv#hook") == 1 then
          health.ok("shadowenv#hook function is available")
        else
          health.error("shadowenv#hook function not found", { "Check that shadowenv.vim plugin is loaded" })
        end

        if vim.fn.executable("shadowenv") == 1 then
          health.ok("shadowenv binary found in PATH")
        else
          health.error("shadowenv binary not found", { "Ensure shadowenv is in home.packages" })
        end

        local autocmds = vim.api.nvim_get_autocmds({ group = "shadowenv" })
        if #autocmds > 0 then
          health.ok(string.format("%d autocommands registered (DirChanged/VimEnter)", #autocmds))
        else
          health.warn("No shadowenv autocommands found")
        end

        -- Use the window cwd, which is what shadowenv operates on
        local cwd = vim.fn.getcwd(0)

        -- Walk up from cwd to find .shadowenv.d
        local shadowenv_root = nil
        local dir = cwd
        while true do
          if vim.fn.isdirectory(dir .. "/.shadowenv.d") == 1 then
            shadowenv_root = dir
            break
          end
          local parent = vim.fn.fnamemodify(dir, ":h")
          if parent == dir then break end
          dir = parent
        end

        if not shadowenv_root then
          health.info(string.format("No .shadowenv.d found above %s", cwd))
          return
        end

        local shadowenv_data = vim.fn.getenv("__shadowenv_data")
        if shadowenv_data == vim.NIL or shadowenv_data == "" then
          health.error(
            string.format("Found .shadowenv.d at %s but no shadowenv is loaded", shadowenv_root),
            { "The shadowenv hook may not have fired yet", "Check :autocmd shadowenv" }
          )
          return
        end

        -- __shadowenv_data is "<hash>:<json>", parse the JSON portion
        local json_str = shadowenv_data:match("^[^:]+:(.+)$")
        if not json_str then
          health.warn("Could not parse __shadowenv_data format")
          return
        end

        local ok, data = pcall(vim.json.decode, json_str)
        if not ok or not data.prev_dirs then
          health.warn("Could not parse __shadowenv_data to verify directory match")
          return
        end

        -- prev_dirs contains relative directory names; resolve against cwd for comparison
        local leaf = vim.fn.fnamemodify(shadowenv_root, ":t")
        local found = false
        for _, d in ipairs(data.prev_dirs) do
          if d == leaf then found = true; break end
        end
        if found then
          health.ok(string.format("shadowenv loaded for %s", shadowenv_root))
        else
          health.error(
            string.format("shadowenv active but not for %s (loaded: %s)", shadowenv_root, table.concat(data.prev_dirs, ", ")),
            { "Try :cd to the buffer directory and run :ShadowenvHook" }
          )
        end
      end

      return M
    '';
  };
}
