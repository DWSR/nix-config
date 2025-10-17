{config, ...}:
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
        action = "<cmd>call QuickFixToggle()<CR>";
        key = "<C-q>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Toggle quickfix";
        };
      }
      {
        action = "<Esc><cmd>m .+1<CR>==gi";
        key = "<A-j>";
        mode = ["i"];

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line down 1";
        };
      }
      {
        action = "<Esc><cmd>m .-2<CR>==gi";
        key = "<A-k>";
        mode = ["i"];

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line up 1";
        };
      }
      {
        action = "<cmd>m .+1<CR>==";
        key = "<A-j>";
        mode = ["n"];

        options = {
          silent = true;
          noremap = true;
          desc = "Move current line down 1";
        };
      }
      {
        action = "<cmd>m .-2<CR>==";
        key = "<A-k>";
        mode = ["n"];

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
      # Easier window nav
      {
        action = "<C-w>h";
        key = "<C-h>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
        };
      }
      {
        action = "<C-w>j";
        key = "<C-j>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
        };
      }
      {
        action = "<C-w>k";
        key = "<C-k>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
        };
      }
      {
        action = "<C-w>l";
        key = "<C-l>";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
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
        action = "<cmd>lua vim.lsp.buf.hover()<cr>";
        key = "K";
        mode = "n";

        options = {
          silent = true;
          noremap = true;
          desc = "Show LSP hover";
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
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_definitions() end";
        key = "<leader>gd";

        options = {
          silent = true;
          noremap = true;
          desc = "Goto definition";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_declarations() end";
        key = "<leader>gD";

        options = {
          silent = true;
          noremap = true;
          desc = "Goto declaration";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_references() end";
        key = "<leader>gr";

        options = {
          silent = true;
          noremap = true;
          desc = "Goto references";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_implementations() end";
        key = "<leader>gI";

        options = {
          silent = true;
          noremap = true;
          desc = "Goto implementation";
        };
      }
      {
        action = helpers.mkRaw "function() Snacks.picker.lsp_type_definitions() end";
        key = "<leader>gy";

        options = {
          silent = true;
          noremap = true;
          desc = "Goto type definition";
        };
      }
      {
        action = "<cmd>lua vim.lsp.buf.code_action()<CR>";
        key = "<leader>la";

        options = {
          silent = true;
          noremap = true;
          desc = "Code actions";
        };
      }
      {
        action = "<cmd>lua vim.lsp.buf.format()<CR>";
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
    ];
  };
}
