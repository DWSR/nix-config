_: {
  programs.nixvim.plugins.lazygit.enable = true;

  programs.nixvim.keymaps = [
    {
      action = "<cmd>LazyGit<CR>";
      key = "<leader>gg";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "LazyGit";
      };
    }
    {
      action = "<cmd>lua Snacks.picker.git_log_file()<CR>";
      key = "<leader>gl";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "Git file log";
      };
    }
    {
      action = "<cmd>lua Snacks.picker.git_log()<CR>";
      key = "<leader>gc";
      mode = "n";
      options = {
        silent = true;
        noremap = true;
        desc = "Git commits";
      };
    }
  ];
}
