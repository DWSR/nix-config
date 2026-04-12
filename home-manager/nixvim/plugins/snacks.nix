_: {
  programs.nixvim = {
    plugins.snacks = {
      enable = true;
      autoLoad = true;

      settings = {
        # Enable snacks notifier — used by noice as the notification backend
        notifier.enabled = true;
      };
    };

    keymaps = [
      {
        action = "<cmd>lua Snacks.picker.diagnostics_buffer()<CR>";
        key = "<leader>sd";
        mode = [ "n" ];

        options = {
          silent = true;
          noremap = true;
          desc = "Buffer diagnostics";
        };
      }
      {
        action = "<cmd>lua Snacks.picker.diagnostics()<CR>";
        key = "<leader>sD";
        mode = [ "n" ];

        options = {
          silent = true;
          noremap = true;
          desc = "Workspace diagnostics";
        };
      }
    ];
  };
}
