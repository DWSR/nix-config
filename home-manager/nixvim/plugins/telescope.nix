_: {
  programs.nixvim = {

    plugins.telescope = {
      enable = true;

      enabledExtensions = [ ];

      keymaps = { };

      settings = {
        defaults = {
          file_ignore_patterns = [
            "node_modules"
            "vendor"
            ".git/"
            ".hg/"
            ".svn/"
            "__pycache__/"
            "*.pyc"
            "*.pyo"
          ];
          # mappings = {
          #   i = {
          #     ["<C-n>"] = "move_selection_next";
          #     ["<C-p>"] = "move_selection_previous";
          #     ["<C-c>"] = "close";
          #     ["<Esc>"] = "close";
          #   };
          # };
        };
      };
    };
  };
}
