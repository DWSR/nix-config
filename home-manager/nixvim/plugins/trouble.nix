_: {
  programs.nixvim = {
    plugins.trouble.enable = true;

    keymaps = [
      {
        action = "<cmd>Trouble diagnostics toggle<CR>";
        key = "<leader>xx";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Workspace diagnostics (Trouble)";
        };
      }
      {
        action = "<cmd>Trouble diagnostics toggle filter.buf=0<CR>";
        key = "<leader>xd";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Buffer diagnostics (Trouble)";
        };
      }
      {
        action = "<cmd>Trouble qflist toggle<CR>";
        key = "<leader>xq";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Quickfix list (Trouble)";
        };
      }
      {
        action = "<cmd>Trouble loclist toggle<CR>";
        key = "<leader>xl";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "Location list (Trouble)";
        };
      }
      {
        action = "<cmd>Trouble lsp_references toggle<CR>";
        key = "<leader>xr";
        mode = "n";
        options = {
          silent = true;
          noremap = true;
          desc = "LSP references (Trouble)";
        };
      }
    ];
  };
}
