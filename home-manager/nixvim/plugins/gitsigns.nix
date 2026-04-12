_: {
  programs.nixvim.plugins.gitsigns.enable = true;

  programs.nixvim.keymaps = [
    {
      action = "<cmd>Gitsigns toggle_current_line_blame<CR>";
      key = "<leader>gb";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "Toggle line blame";
      };
    }
    {
      action = "<cmd>Gitsigns preview_hunk<CR>";
      key = "<leader>gp";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "Preview hunk";
      };
    }
    {
      action = "<cmd>Gitsigns stage_hunk<CR>";
      key = "<leader>gs";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "Stage hunk";
      };
    }
    {
      action = "<cmd>Gitsigns reset_hunk<CR>";
      key = "<leader>gr";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "Reset hunk";
      };
    }
    {
      action = "<cmd>Gitsigns stage_buffer<CR>";
      key = "<leader>gS";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "Stage buffer";
      };
    }
  ];
}
