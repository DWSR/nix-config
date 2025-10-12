{ ... }:
{
  programs.nixvim.plugins.neo-tree = {
    enable = true;
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
