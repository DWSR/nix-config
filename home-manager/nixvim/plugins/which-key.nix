_: {
  programs.nixvim.plugins.which-key = {
    enable = true;

    settings = {
      delay = 300;
      preset = "helix";

      plugins = {
        marks = true;
        registers = true;
      };

      spec = [
        {
          __unkeyed = "<leader>a";
          group = "AI";
          mode = [
            "n"
            "v"
          ];
        }
        {
          __unkeyed = "<leader>b";
          group = "Buffer";
          mode = [ "n" ];
        }
        {
          __unkeyed = "<leader>d";
          group = "Debug";
          mode = [
            "n"
            "v"
          ];
        }
        {
          __unkeyed = "<leader>dg";
          group = "Debug Go";
          mode = [ "n" ];
        }
        {
          __unkeyed = "<leader>dp";
          group = "Debug Python";
          mode = [ "n" ];
        }
        {
          __unkeyed = "<leader>dr";
          group = "Debug Rust";
          mode = [ "n" ];
        }
        {
          __unkeyed = "<leader>x";
          group = "Trouble";
          mode = [ "n" ];
        }
        {
          __unkeyed = "<leader>V";
          group = "Display toggles";
          mode = [
            "n"
            "v"
          ];
        }
        {
          __unkeyed = "<leader>s";
          group = "Search";
          mode = [
            "n"
            "v"
          ];
        }
        {
          __unkeyed = "<leader>g";
          group = "Git";
          mode = [
            "n"
            "v"
          ];
        }
        {
          __unkeyed = "<leader>w";
          group = "Resize window";
          mode = [ "n" ];
        }
        {
          __unkeyed = "<leader>l";
          group = "LSP Actions";
          mode = [
            "n"
            "v"
          ];
        }
      ];
    };
  };
}
