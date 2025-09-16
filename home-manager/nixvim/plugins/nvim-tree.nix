{ ... }:
{
  programs.nixvim.plugins.nvim-tree = {
    enable = true;

    autoReloadOnWrite = true;
    openOnSetup = true;

    extraOptions = {
      sort = {
        sorter = "name";
        folders_first = true;
        files_first = false;
      };
    };

    hijackCursor = true;
    hijackUnnamedBufferWhenOpening = true;
    syncRootWithCwd = true;

    git = {
      enable = true;
      ignore = true;
      showOnDirs = true;
      showOnOpenDirs = true;
      timeout = 1000;
    };

    renderer = {
      groupEmpty = true;
      highlightGit = true;
    };

    view = {
      relativenumber = false;
      signcolumn = "yes";
    };
  };

  programs.nixvim.keymaps = [
    {
      action = "<cmd>NvimTreeToggle<CR>";
      key = "<leader>e";

      options = {
        silent = true;
        noremap = true;
        desc = "Toggle File Explorer";
      };
    }
  ];
}
