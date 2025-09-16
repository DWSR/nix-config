{
  programs.nixvim = {
    globals = {
      mapleader = " ";
      maplocalleader = " ";
    };

    keymaps = [
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
        key = "<leader>c";

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
    ];
  };
}
