{ ... }:
{
  programs.nixvim.plugins.lastplace = {
    enable = true;

    settings = {
      lastplace_ignore_filetype = [
        "gitcommit"
        "gitrebase"
        "svn"
        "hgcommit"
        "neo-tree"
        "toggleterm"
      ];
    };
  };
}
