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
      {
        action = "<cmd>lua Snacks.picker.resume()<CR>";
        key = "<leader>sl";
        mode = [ "n" ];
        options = {
          silent = true;
          noremap = true;
          desc = "Resume last search";
        };
      }
      {
        action = "<cmd>lua Snacks.picker.recent()<CR>";
        key = "<leader>sr";
        mode = [ "n" ];
        options = {
          silent = true;
          noremap = true;
          desc = "Recent files";
        };
      }
      {
        action = "<cmd>lua Snacks.picker.help()<CR>";
        key = "<leader>sh";
        mode = [ "n" ];
        options = {
          silent = true;
          noremap = true;
          desc = "Help tags";
        };
      }
      {
        action = "<cmd>lua Snacks.picker.man()<CR>";
        key = "<leader>sM";
        mode = [ "n" ];
        options = {
          silent = true;
          noremap = true;
          desc = "Man pages";
        };
      }
      {
        action = "<cmd>lua Snacks.picker.registers()<CR>";
        key = "<leader>sR";
        mode = [ "n" ];
        options = {
          silent = true;
          noremap = true;
          desc = "Registers";
        };
      }
    ];
  };
}
