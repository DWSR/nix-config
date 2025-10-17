{ ... }:
{
  programs.nixvim.plugins.neo-tree = {
    enable = true;

    settings = {
      filesystem.filtered_items = {
        visible = true;
        never_show = [".git" ".DS_Store" "thumbs.db"];
      };

      open_files_do_not_replace_types = ["terminal" "Trouble" "qf" "edgy"];
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
