{ ... }:
{
  programs.nixvim.plugins.neo-tree = {
    enable = true;

    filesystem.filteredItems = {
      visible = true;
      neverShow = [".git" ".DS_Store" "thumbs.db"];
    };
  };

  programs.nixvim.keymaps = [
    {
      action = "<cmd>Neotree toggle<CR>";
      key = "<leader>e";

      options = {
        silent = true;
        noremap = true;
        desc = "Toggle File Explorer";
      };
    }
  ];

  programs.nixvim.autoCmd = [
    # {
    #   callback = "<cmd>Neotree reveal<CR>";
    #   desc = "Focus buffer file in Neotree";
    #   event = "BufEnter";
    # }
  ];
}
