{ ... }:
{
  programs.nixvim.plugins.toggleterm = {
    enable = true;

    settings = {
      auto_scroll = true;
      close_on_exit = true;
      direction = "float";
      open_mapping = {
        __raw = "[[<c-\\>]]";
      };
      insert_mappings = true;
      size = 20;
      start_in_insert = true;
      terminal_mappings = true;
      winbar.enabled = false;

      float_opts = {
        border = "curved";

        highlights = {
          border = "Normal";
          background = "Normal";
        };
      };
    };
  };

  programs.nixvim.keymaps = [
    {
      action = "<cmd>ToggleTerm size=30 direction=horizontal<cr>";
      key = "<leader>t-";
      mode = [
        "n"
        "i"
      ];

      options = {
        silent = true;
        noremap = true;
        desc = "Split Horizontal";
      };
    }
    {
      action = "<cmd>ToggleTerm size=30 direction=vertical<cr>";
      key = "<leader>t|";
      mode = [
        "n"
        "i"
      ];

      options = {
        silent = true;
        noremap = true;
        desc = "Split Vertical";
      };
    }
  ];

  programs.nixvim.plugins.which-key.settings.spec = [
    {
      __unkeyed = "<leader>t";
      group = "Terminal";
      mode = "n";
    }
  ];
}
