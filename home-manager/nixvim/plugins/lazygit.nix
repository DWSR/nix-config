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
  ];
}
