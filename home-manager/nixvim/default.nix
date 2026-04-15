{
  inputs,
  config,
  ...
}:
let
  helpers = config.lib.nixvim;
in
{
  imports = [
    inputs.nixvim.homeModules.nixvim

    ./keymappings.nix
    ./commands.nix

    ./plugins/actions-preview.nix
    ./plugins/auto-save.nix

    ./plugins/blink-cmp.nix
    ./plugins/bufonly.nix
    ./plugins/codecompanion.nix
    ./plugins/conform.nix
    ./plugins/dap.nix
    ./plugins/devdocs.nix
    ./plugins/direnv.nix
    ./plugins/fidget.nix
    ./plugins/edgy.nix
    ./plugins/git-conflict.nix
    ./plugins/gitcommit.nix
    ./plugins/gitsigns.nix
    ./plugins/illuminate.nix
    ./plugins/img-clip.nix
    ./plugins/indent-blankline.nix
    ./plugins/lastplace.nix
    ./plugins/lazygit.nix
    ./plugins/lsp.nix
    ./plugins/lualine.nix
    ./plugins/markdown-preview.nix
    ./plugins/matchup.nix
    ./plugins/mcphub.nix
    ./plugins/mini-surround.nix
    ./plugins/render-markdown.nix
    ./plugins/navic.nix
    ./plugins/neo-tree.nix
    ./plugins/neoscroll.nix
    ./plugins/noice.nix
    ./plugins/numbertoggle.nix
    ./plugins/nvim-lsp-file-operations.nix
    ./plugins/smear-cursor.nix
    ./plugins/snacks.nix
    ./plugins/todo-comments.nix
    ./plugins/toggleterm.nix
    ./plugins/treesitter.nix
    ./plugins/treesitter-textobjects.nix
    ./plugins/shadowenv.nix
    ./plugins/zellij-nav.nix
    ./plugins/twilight.nix
    ./plugins/which-key.nix
    ./plugins/visual-whitespace.nix
  ];

  programs.nixvim = {
    enable = true;
    defaultEditor = true;
    withNodeJs = true;
    withPerl = true;
    withPython3 = true;
    withRuby = true;
    viAlias = true;
    vimAlias = true;
    vimdiffAlias = true;

    colorschemes = {
      nord = {
        enable = true;

        settings = {
          disable_background = true;
          borders = true;
          italic = true;
        };
      };
    };

    highlightOverride = {
      EdgyWinSeparator = {
        fg = "#000000";
      };
      EdgyWinBar = {
        fg = "#88C0D0";
        bg = "#3B4252";
        bold = true;
      };
    };

    luaLoader.enable = true;
    plugins.lz-n.enable = true;

    opts = {
      backup = false;
      breakindent = true;
      breakindentopt = "sbr";
      showbreak = "↪>\\";
      clipboard = "unnamedplus";
      cmdheight = 1;
      completeopt = [
        "menuone"
        "noselect"
      ];
      conceallevel = 0;
      fileencoding = "utf-8";
      foldmethod = "manual";
      foldexpr = "";
      hidden = true;
      hlsearch = true;
      ignorecase = true;
      mouse = "a";
      pumheight = 10;
      showmode = false;
      smartcase = true;
      splitbelow = true;
      splitright = true;
      swapfile = false;
      termguicolors = true;
      timeoutlen = 2000;
      title = true;
      undodir = helpers.mkRaw ''vim.fn.stdpath("cache") .. "/undo"'';
      undofile = true;
      updatetime = 100;
      writebackup = false;
      expandtab = true;
      shiftwidth = 2;
      tabstop = 2;
      cursorline = true;
      number = true;
      numberwidth = 4;
      signcolumn = "yes";
      wrap = true;
      scrolloff = 8;
      fillchars = "eob: ";
      sidescrolloff = 8;
      showcmd = false;
      ruler = false;
      laststatus = 3;
    };

    performance = {
      byteCompileLua = {
        enable = true;
        configs = true;
        initLua = true;
        nvimRuntime = true;
        plugins = true;
      };
    };

    diagnostic = {
      settings = {
        virtual_text = false;
        signs = true;
        underline = true;
        update_in_insert = false;
        severity_sort = false;
      };
    };

    autoCmd = [
      {
        callback = helpers.mkRaw ''
          function()
            local opts = {
              focusable = false,
              close_events = { "BufLeave", "CursorMoved", "InsertEnter", "FocusLost" },
              border = 'rounded',
              source = 'always',
              prefix = ' ',
              scope = 'cursor',
            }

            vim.diagnostic.open_float(opts)
          end
        '';

        desc = "Show diagnostics on cursor hold";
        event = "CursorHold";
      }

      # Highlight yanked text briefly
      {
        callback = helpers.mkRaw ''
          function()
            vim.highlight.on_yank({ higroup = "Visual", timeout = 200 })
          end
        '';
        desc = "Highlight on yank";
        event = "TextYankPost";
      }

      # Equalize window sizes when terminal is resized
      {
        command = "tabdo wincmd =";
        desc = "Auto-resize windows on terminal resize";
        event = "VimResized";
      }

      # Quick-close ephemeral buffers with q
      {
        callback = helpers.mkRaw ''
          function()
            vim.bo.buflisted = false
            vim.keymap.set("n", "q", "<cmd>close<CR>", { buffer = true, silent = true })
          end
        '';
        desc = "Close ephemeral buffers with q";
        event = "FileType";
        pattern = [
          "qf"
          "help"
          "man"
          "lspinfo"
          "notify"
          "checkhealth"
          "startuptime"
          "dap-float"
        ];
      }
    ];

    plugins = {
      nvim-autopairs.enable = true;
      nui.enable = true;
      web-devicons.enable = true;
    };

    extraConfigLuaPre = ''
      -- Common kill function for bdelete and bwipeout
      -- credits: based on bbye and nvim-bufdel
      ---@param kill_command? string defaults to "bd"
      ---@param bufnr? number defaults to the current buffer
      ---@param force? boolean defaults to false
      function buf_kill(kill_command, bufnr, force)
        kill_command = kill_command or "bd"

        local bo = vim.bo
        local api = vim.api
        local fmt = string.format
        local fn = vim.fn

        if bufnr == 0 or bufnr == nil then
          bufnr = api.nvim_get_current_buf()
        end

        local bufname = api.nvim_buf_get_name(bufnr)

        if not force then
          local choice
          if bo[bufnr].modified then
            choice = fn.confirm(fmt([[Save changes to "%s"?]], bufname), "&Yes\n&No\n&Cancel")
            if choice == 1 then
              vim.api.nvim_buf_call(bufnr, function()
                vim.cmd("w")
              end)
            elseif choice == 2 then
              force = true
            else return
            end
          elseif api.nvim_get_option_value("buftype", { buf = bufnr }) == "terminal" then
            choice = fn.confirm(fmt([[Close "%s"?]], bufname), "&Yes\n&No\n&Cancel")
            if choice == 1 then
              force = true
            else
              return
            end
          end
        end

        -- Get list of windows IDs with the buffer to close
        local windows = vim.tbl_filter(function(win)
          return api.nvim_win_get_buf(win) == bufnr
        end, api.nvim_list_wins())

        if force then
          kill_command = kill_command .. "!"
        end

        -- Get list of active buffers
        local buffers = vim.tbl_filter(function(buf)
          return api.nvim_buf_is_valid(buf) and bo[buf].buflisted
        end, api.nvim_list_bufs())

        -- If there is only one buffer (which has to be the current one), vim will
        -- create a new buffer on :bd.
        -- For more than one buffer, pick the previous buffer (wrapping around if necessary)
        if #buffers > 1 and #windows > 0 then
          for i, v in ipairs(buffers) do
            if v == bufnr then
              local prev_buf_idx = i == 1 and #buffers or (i - 1)
              local prev_buffer = buffers[prev_buf_idx]
              for _, win in ipairs(windows) do
                api.nvim_win_set_buf(win, prev_buffer)
              end
            end
          end
        end

        -- Check if buffer still exists, to ensure the target buffer wasn't killed
        -- due to options like bufhidden=wipe.
        if api.nvim_buf_is_valid(bufnr) and bo[bufnr].buflisted then
          vim.cmd(string.format("%s %d", kill_command, bufnr))
        end
      end

    '';
  };
}
