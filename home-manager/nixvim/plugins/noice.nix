_: {
  programs.nixvim.keymaps = [
    {
      action = "<cmd>Noice history<CR>";
      key = "<leader>sN";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "Message log (all)";
      };
    }
  ];

  programs.nixvim.plugins.noice = {
    enable = true;

    settings = {
      lsp = {
        # Disable LSP progress — fidget.nvim handles this
        progress.enabled = false;

        override = {
          "vim.lsp.util.convert_input_to_markdown_lines" = true;
          "vim.lsp.util.stylize_markdown" = true;
          "cmp.entry.get_documentation" = true;
        };
      };

      # Notifications use the default "notify" view, which auto-resolves
      # to snacks notifier (first in chain: snacks → nvim-notify → mini)

      presets = {
        bottom_search = true;
        command_palette = true;
        long_message_to_split = true;
      };
    };
  };
}
