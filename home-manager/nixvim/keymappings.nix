{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim = {
    globals = {
      mapleader = " ";
      maplocalleader = " ";
    };

    keymaps = [
      {
        action = "<cmd>cnext<CR>";
        key = "]q";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Next quickfix";
        };
      }
      {
        action = "<cmd>cprev<CR>";
        key = "[q";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Previous quickfix";
        };
      }
      {
        action = "<Esc><cmd>m .+1<CR>==gi";
        key = "<A-j>";
        mode = [ "i" ];

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line down 1";
        };
      }
      {
        action = "<Esc><cmd>m .-2<CR>==gi";
        key = "<A-k>";
        mode = [ "i" ];

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line up 1";
        };
      }
      {
        action = "<cmd>m .+1<CR>==";
        key = "<A-j>";
        mode = [ "n" ];

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line down 1";
        };
      }
      {
        action = "<cmd>m .-2<CR>==";
        key = "<A-k>";
        mode = [ "n" ];

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line up 1";
        };
      }
      {
        action = "<Esc><cmd>m '>+1<CR>gv-gv";
        key = "<A-j>";
        mode = "x";

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line/block down 1";
        };
      }
      {
        action = "<Esc><cmd>m '<-2<CR>gv-gv";
        key = "<A-k>";
        mode = "x";

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line/block up 1";
        };
      }
      {
        action = "<cmd>confirm q<CR>";
        key = "<leader>q";

        options = {
          silent = true;
          noremap = true;
          desc = "Quit";
        };
      }
      {
        action = "<cmd>BufferKill<CR>";
        key = "<leader>bc";

        options = {
          silent = true;
          noremap = true;
          desc = "Close Buffer";
        };
      }
      {
        action = "<cmd>nohlsearch<CR>";
        key = "<leader>h";

        options = {
          silent = true;
          noremap = true;
          desc = "Remove search result highlight";
        };
      }
      {
        action = ":vsplit<CR>";
        key = "|";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Vertical split";
        };
      }
      {
        action = ":split<CR>";
        key = "-";

        options = {
          silent = true;
          noremap = true;
          desc = "Horizontal split";
        };
      }
      # Navigate across vim splits, zellij panes, and zellij tabs
      {
        action = "<cmd>ZellijNavigateLeftTab<CR>";
        key = "<C-h>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Navigate left (vim/zellij/tab)";
        };
      }
      {
        action = "<cmd>ZellijNavigateDown<CR>";
        key = "<C-j>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Navigate down (vim/zellij)";
        };
      }
      {
        action = "<cmd>ZellijNavigateUp<CR>";
        key = "<C-k>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Navigate up (vim/zellij)";
        };
      }
      {
        action = "<cmd>ZellijNavigateRightTab<CR>";
        key = "<C-l>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Navigate right (vim/zellij/tab)";
        };
      }
      # Window resizing
      {
        action = "<cmd>resize +5<CR>";
        key = "<leader>w+";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Increase window height";
        };
      }
      {
        action = "<cmd>resize -5<CR>";
        key = "<leader>w-";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Decrease window height";
        };
      }
      {
        action = "<cmd>vertical resize +5<CR>";
        key = "<leader>w>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Increase window width";
        };
      }
      {
        action = "<cmd>vertical resize -5<CR>";
        key = "<leader>w<";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Decrease window width";
        };
      }
      {
        action = "<cmd>wincmd =<CR>";
        key = "<leader>w=";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Equalize window sizes";
        };
      }
      # Easier indentation
      {
        action = "<gv";
        key = "<";
        mode = "x";

        options = {
          silent = true;
          noremap = true;
        };
      }
      {
        action = ">gv";
        key = ">";
        mode = "x";

        options = {
          silent = true;
          noremap = true;
        };
      }
      {
        action = "<cmd>set relativenumber!<CR>";
        key = "<leader>Vn";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Toggle relative line numbers";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.grep() end";
        key = "<leader>st";

        options = {
          silent = true;
          noremap = true;
          desc = "Live text search";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.smart() end";
        key = "<leader>sf";

        options = {
          silent = true;
          noremap = true;
          desc = "Live file search";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_symbols() end";
        key = "<leader>ss";

        options = {
          silent = true;
          noremap = true;
          desc = "Document LSP symbols";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_workspace_symbols() end";
        key = "<leader>sS";

        options = {
          silent = true;
          noremap = true;
          desc = "Workspace LSP symbols";
        };
      }
      # LSP goto bindings — bare g* keys (standard convention, no leader prefix)
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_definitions() end";
        key = "gd";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Goto definition";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_declarations() end";
        key = "gD";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Goto declaration";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_references() end";
        key = "gr";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Goto references";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_implementations() end";
        key = "gI";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Goto implementation";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_type_definitions() end";
        key = "gy";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Goto type definition";
        };
      }

      # Comment toggle — uses neovim 0.10+ built-in gc/gcc operator
      {
        action = "gcc";
        key = "<leader>/";
        mode = "n";
        options = {
          remap = true;
          silent = true;
          desc = "Toggle line comment";
        };
      }
      {
        action = "gc";
        key = "<leader>/";
        mode = "v";
        options = {
          remap = true;
          silent = true;
          desc = "Toggle line comment";
        };
      }
      {
        action = "<cmd>lua require('actions-preview').code_actions()<CR>";
        key = "<leader>la";

        options = {
          silent = true;
          noremap = true;
          desc = "Code actions";
        };
      }
      {
        action = "<cmd>lua require('conform').format({ lsp_format = 'fallback' })<CR>";
        key = "<leader>lf";

        options = {
          silent = true;
          noremap = true;
          desc = "Format";
        };
      }
      {
        action = "<cmd>lua vim.lsp.buf.rename()<CR>";
        key = "<leader>lr";

        options = {
          silent = true;
          noremap = true;
          desc = "Rename";
        };
      }
      {
        action = "<cmd>lua vim.lsp.buf.signature_help()<CR>";
        key = "<leader>ls";

        options = {
          silent = true;
          noremap = true;
          desc = "Show signature";
        };
      }

      # Diagnostic navigation
      {
        action = "<cmd>lua vim.diagnostic.goto_next()<CR>";
        key = "]d";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Next diagnostic";
        };
      }
      {
        action = "<cmd>lua vim.diagnostic.goto_prev()<CR>";
        key = "[d";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Previous diagnostic";
        };
      }

    ];
  };
}
